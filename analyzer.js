// analyzer.js - 안정성과 성능이 개선된 웹워커

importScripts('lib/jszip.min.js');

// 진행률 추적을 위한 변수들
let totalSteps = 0;
let currentStep = 0;

// 진행률 업데이트 함수
function updateProgress(message, step = null) {
    if (step !== null) {
        currentStep = step;
    } else {
        currentStep++;
    }
    
    const percentage = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
    self.postMessage({ 
        status: 'progress', 
        message: `${message} (${percentage}%)`,
        progress: percentage
    });
}

// 에러 핸들링 래퍼
function safeAsync(asyncFn, errorMessage) {
    return async (...args) => {
        try {
            return await asyncFn(...args);
        } catch (error) {
            console.error(`[Worker] ${errorMessage}:`, error);
            throw new Error(`${errorMessage}: ${error.message}`);
        }
    };
}

// 메인 메시지 핸들러
self.onmessage = async (event) => {
    const { file } = event.data;
    
    try {
        updateProgress('EPUB 파일 로딩 시작...', 0);
        await processEpubFile(file);
        
    } catch (error) {
        console.error('[Worker] 전체 처리 중 오류:', error);
        self.postMessage({ 
            status: 'error', 
            message: error.message || '알 수 없는 오류가 발생했습니다.' 
        });
    }
};

// 메인 EPUB 처리 함수
const processEpubFile = safeAsync(async (file) => {
    // 전체 작업 단계 설정
    totalSteps = 6;
    currentStep = 0;
    
    // 1단계: ZIP 파일 로딩
    updateProgress('ZIP 아카이브 분석 중...');
    const zip = await JSZip.loadAsync(file);
    
    // 2단계: 컨테이너 및 OPF 경로 추출
    updateProgress('메타데이터 추출 중...');
    const { opfPath, opfXmlString } = await extractMetadata(zip);
    
    // 3단계: 콘텐츠 파일 추출
    updateProgress('챕터 내용 추출 중...');
    const contentFiles = await extractContentFiles(zip);
    
    // 4단계: 이미지 리소스 처리
    updateProgress('이미지 리소스 처리 중...');
    const imageMapObject = await processImageResources(zip);
    
    // 5단계: 데이터 검증
    updateProgress('데이터 무결성 검증 중...');
    validateExtractedData(opfXmlString, contentFiles, imageMapObject);
    
    // 6단계: 완료
    updateProgress('분석 완료!');
    
    // 결과 전송
    self.postMessage({
        status: 'success_raw_strings',
        payload: {
            opfPath,
            opfXmlString,
            contentFiles,
            imageMapObject
        }
    });
    
}, '파일 처리');

// 메타데이터 추출
const extractMetadata = safeAsync(async (zip) => {
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) {
        throw new Error("META-INF/container.xml 파일을 찾을 수 없습니다.");
    }
    
    const containerXmlString = await containerFile.async("string");
    
    // 정규식보다 안전한 XML 파싱 방식 사용
    const opfPathMatch = containerXmlString.match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (!opfPathMatch || !opfPathMatch[1]) {
        throw new Error(".opf 파일 경로를 찾을 수 없습니다.");
    }
    
    const opfPath = opfPathMatch[1];
    const opfFile = zip.file(opfPath);
    if (!opfFile) {
        throw new Error(`OPF 파일을 찾을 수 없습니다: ${opfPath}`);
    }
    
    const opfXmlString = await opfFile.async("string");
    
    return { opfPath, opfXmlString };
}, '메타데이터 추출');

// 콘텐츠 파일 추출 (배치 처리로 성능 향상)
const extractContentFiles = safeAsync(async (zip) => {
    const contentFiles = {};
    const contentFileEntries = [];
    
    // 1. HTML/XHTML 파일들을 먼저 식별
    for (const path in zip.files) {
        if (path.match(/\.(html|xhtml)$/i) && !zip.files[path].dir) {
            contentFileEntries.push({ path, file: zip.files[path] });
        }
    }
    
    // 2. 배치로 처리하여 메모리 사용량 제어
    const batchSize = 5;
    for (let i = 0; i < contentFileEntries.length; i += batchSize) {
        const batch = contentFileEntries.slice(i, i + batchSize);
        
        // 배치 내의 파일들을 병렬 처리
        const batchPromises = batch.map(async ({ path, file }) => {
            try {
                const content = await file.async("string");
                return { path, content };
            } catch (error) {
                console.warn(`[Worker] 콘텐츠 파일 처리 실패: ${path}`, error);
                return { path, content: '' };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        // 결과를 contentFiles에 저장
        batchResults.forEach(({ path, content }) => {
            contentFiles[path] = content;
        });
        
        // 진행률 업데이트
        const progress = Math.min(100, Math.round(((i + batchSize) / contentFileEntries.length) * 100));
        updateProgress(`콘텐츠 파일 처리 중... ${i + batchSize}/${contentFileEntries.length}`);
        
        // 브라우저에 제어권 양보
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    
    if (Object.keys(contentFiles).length === 0) {
        throw new Error("유효한 HTML/XHTML 콘텐츠 파일을 찾을 수 없습니다.");
    }
    
    return contentFiles;
}, '콘텐츠 파일 추출');

// 이미지 리소스 처리 (ArrayBuffer로 전송하여 메인 스레드에서 Blob URL 생성)
const processImageResources = safeAsync(async (zip) => {
    const imageDataMap = new Map();
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i;
    const imageEntries = [];
    
    // 1. 이미지 파일들을 먼저 식별
    for (const path in zip.files) {
        if (path.match(imageExtensions) && !zip.files[path].dir) {
            imageEntries.push({ 
                originalPath: path,
                file: zip.files[path] 
            });
        }
    }
    
    if (imageEntries.length === 0) {
        return {};
    }
    
    console.log(`[Worker] 발견된 이미지 파일들:`, imageEntries.map(e => e.originalPath));
    
    // 2. 이미지를 ArrayBuffer로 처리하여 메인 스레드로 전송
    const batchSize = 5;
    for (let i = 0; i < imageEntries.length; i += batchSize) {
        const batch = imageEntries.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async ({ originalPath, file }) => {
            try {
                // ArrayBuffer로 이미지 데이터 추출
                const arrayBuffer = await file.async('arraybuffer');
                const mimeType = getMimeTypeFromPath(originalPath);
                
                return { 
                    originalPath, 
                    arrayBuffer: Array.from(new Uint8Array(arrayBuffer)), // 전송 가능한 형태로 변환
                    mimeType
                };
            } catch (error) {
                console.warn(`[Worker] 이미지 처리 실패: ${originalPath}`, error);
                return { originalPath, arrayBuffer: null, mimeType: null };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        // 결과를 imageDataMap에 저장 (여러 경로 패턴으로 저장)
        batchResults.forEach(({ originalPath, arrayBuffer, mimeType }) => {
            if (arrayBuffer && mimeType) {
                const imageData = { arrayBuffer, mimeType };
                
                // 다양한 경로 패턴으로 저장
                imageDataMap.set(originalPath, imageData);
                
                // 정규화된 경로 (백슬래시 -> 슬래시)
                const normalizedPath = originalPath.replace(/\\/g, '/');
                imageDataMap.set(normalizedPath, imageData);
                
                // 파일명만
                const fileName = originalPath.split(/[\/\\]/).pop();
                if (fileName) {
                    imageDataMap.set(fileName, imageData);
                    
                    // 일반적인 EPUB 이미지 경로 패턴들
                    imageDataMap.set(`Images/${fileName}`, imageData);
                    imageDataMap.set(`OEBPS/Images/${fileName}`, imageData);
                    imageDataMap.set(`Text/../Images/${fileName}`, imageData);
                    imageDataMap.set(`images/${fileName}`, imageData); // 소문자 버전
                    imageDataMap.set(`OEBPS/images/${fileName}`, imageData);
                }
            }
        });
        
        updateProgress(`이미지 처리 중... ${Math.min(i + batchSize, imageEntries.length)}/${imageEntries.length}`);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    
    console.log(`[Worker] 이미지 데이터 준비 완료. 총 ${imageDataMap.size}개 경로 패턴`);
    return Object.fromEntries(imageDataMap);
}, '이미지 리소스 처리');

// MIME 타입 추정 함수
function getMimeTypeFromPath(path) {
    const extension = path.toLowerCase().split('.').pop();
    const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'bmp': 'image/bmp'
    };
    return mimeTypes[extension] || 'image/jpeg';
}

// 추출된 데이터 검증
const validateExtractedData = safeAsync((opfXmlString, contentFiles, imageMapObject) => {
    // OPF 파일 기본 검증
    if (!opfXmlString || opfXmlString.length < 100) {
        throw new Error("OPF 파일이 비어있거나 너무 작습니다.");
    }
    
    // 필수 OPF 요소 검증
    const requiredElements = ['manifest', 'spine'];
    for (const element of requiredElements) {
        if (!opfXmlString.includes(`<${element}`)) {
            throw new Error(`OPF 파일에서 필수 요소 <${element}>를 찾을 수 없습니다.`);
        }
    }
    
    // 콘텐츠 파일 검증
    const contentCount = Object.keys(contentFiles).length;
    if (contentCount === 0) {
        throw new Error("콘텐츠 파일이 하나도 추출되지 않았습니다.");
    }
    
    // 이미지 맵 검증
    const imageCount = Object.keys(imageMapObject).length;
    
    updateProgress(`검증 완료: 콘텐츠 ${contentCount}개, 이미지 ${imageCount}개`);
}, '데이터 검증');

// 에러 발생 시 정리 작업
self.onerror = (error) => {
    console.error('[Worker] 예상치 못한 오류:', error);
    self.postMessage({ 
        status: 'error', 
        message: '웹워커에서 예상치 못한 오류가 발생했습니다.' 
    });
};

// 메모리 정리를 위한 주기적 가비지 컬렉션 힌트
let gcCounter = 0;
setInterval(() => {
    gcCounter++;
    if (gcCounter % 10 === 0 && typeof gc !== 'undefined') {
        gc();
    }
}, 1000);
importScripts('./lib/jszip.min.js');

let totalSteps = 0;
let currentStep = 0;

function updateProgress(message, step = null) {
    if (step !== null) currentStep = step;
    else currentStep++;
    
    const percentage = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
    self.postMessage({ 
        status: 'progress', 
        message: `${message} (${percentage}%)`,
        progress: percentage
    });
}

self.onmessage = async (event) => {
    const { file } = event.data;
    try {
        updateProgress('EPUB 파일 로딩 시작...', 0);
        await processEpubFile(file);
    } catch (error) {
        console.error('[Worker] EPUB 처리 중 오류:', error);
        self.postMessage({ status: 'error', message: `EPUB 처리 중 오류 발생: ${error.message}` });
    }
};

const processEpubFile = async (file) => {
    totalSteps = 5;
    currentStep = 0;
    
    updateProgress('ZIP 아카이브 분석 중...');
    const zip = await JSZip.loadAsync(file);
    
    updateProgress('메타데이터 추출 중...');
    const { opfPath, opfXmlString } = await extractMetadata(zip);
    
    updateProgress('챕터 내용 추출 중...');
    const contentFiles = await extractContentFiles(zip);
    
    updateProgress('이미지 리소스 처리 중...');
    const imageMapObject = await processImageResources(zip);
    
    updateProgress('분석 완료! 데이터 전송 중...');
    self.postMessage({
        status: 'success_raw_strings',
        payload: { opfPath, opfXmlString, contentFiles, imageMapObject }
    });
};

const extractMetadata = async (zip) => {
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) throw new Error("META-INF/container.xml 파일을 찾을 수 없습니다.");
    
    const containerXmlString = await containerFile.async("string");
    const opfPathMatch = containerXmlString.match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (!opfPathMatch || !opfPathMatch[1]) throw new Error(".opf 파일 경로를 찾을 수 없습니다.");
    
    const opfPath = opfPathMatch[1];
    const opfFile = zip.file(opfPath);
    if (!opfFile) throw new Error(`OPF 파일을 찾을 수 없습니다: ${opfPath}`);
    
    const opfXmlString = await opfFile.async("string");
    return { opfPath, opfXmlString };
};

const extractContentFiles = async (zip) => {
    const contentFiles = {};
    const promises = [];
    for (const path in zip.files) {
        if (path.match(/\.(html|xhtml)$/i) && !zip.files[path].dir) {
            promises.push(
                zip.files[path].async("string").then(content => {
                    contentFiles[path] = content;
                })
            );
        }
    }
    await Promise.all(promises);
    return contentFiles;
};

const processImageResources = async (zip) => {
    const imageDataMap = new Map();
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i;
    const promises = [];

    for (const path in zip.files) {
        const fileEntry = zip.files[path];
        if (path.match(imageExtensions) && !fileEntry.dir) {
            promises.push(
                fileEntry.async('arraybuffer').then(arrayBuffer => {
                    const mimeType = getMimeTypeFromPath(path);
                    const imageData = { arrayBuffer: Array.from(new Uint8Array(arrayBuffer)), mimeType };
                    
                    const normalizedPath = path.replace(/\\/g, '/');
                    const fileName = path.split(/[\/\\]/).pop();
                    imageDataMap.set(path, imageData);
                    imageDataMap.set(normalizedPath, imageData);
                    if (fileName) {
                        imageDataMap.set(fileName, imageData);
                        imageDataMap.set(`Images/${fileName}`, imageData);
                        imageDataMap.set(`OEBPS/Images/${fileName}`, imageData);
                        imageDataMap.set(`images/${fileName}`, imageData);
                        imageDataMap.set(`OEBPS/images/${fileName}`, imageData);
                    }
                }).catch(err => {
                    console.error(`[Worker] 이미지 처리 오류: ${path}`, err);
                })
            );
        }
    }
    await Promise.all(promises);
    return Object.fromEntries(imageDataMap);
};

function getMimeTypeFromPath(path) {
    const extension = path.toLowerCase().split('.').pop();
    const mimeTypes = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml', 'bmp': 'image/bmp'
    };
    return mimeTypes[extension] || 'application/octet-stream';
}
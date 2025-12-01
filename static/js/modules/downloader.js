// js/modules/downloader.js

import * as dom from './dom.js';
import { getAlbumTracksAPI, getTrackInfo, getItemInfoAPI, getLyricsAPI, getVideoPlaybackInfoAPI } from './api.js';
import { settingsManager } from './settings.js';
import { loadFFmpeg, applyMetadata, mergeHiresSegments, mergeVideoSegments, muxVideoAndAudio } from './ffmpeg.js';
import { updateDownloadManagerStatus } from './ui.js';

let sessionDirectoryHandle = null;
let nativeSessionBasePath = null;

const sanitize = (name) => String(name || '').replace(/[\\/:*?"<>|]/g, '_');
const simpleJoinPath = (...args) => args.filter(Boolean).join('/');

export const downloadQueue = {
    queue: [],
    isProcessing: false,
    currentTask: null,
    abortController: null,

    init() {
        if (window.electronAPI && window.electronAPI.onDownloadProgress) {
            window.electronAPI.onDownloadProgress((data) => {
                if (this.isProcessing && this.currentTask && String(data.trackId).startsWith(String(this.currentTask.trackId))) {
                    updateDownloadManagerStatus({ trackStatus: data.speedText ? `${data.statusText} ${data.speedText}` : data.statusText });

                    const { percent: trackPercent } = data;
                    const { completedTracks, totalTracks } = this.currentTask;

                    if (totalTracks > 0) {
                        const overallPercent = ((completedTracks + (trackPercent || 0) / 100) / totalTracks) * 100;

                        if (dom.downloadProgressBar) {
                            dom.downloadProgressBar.style.width = `${overallPercent}%`;
                        }
                        const modalProgressBar = dom.downloadQueueBody.querySelector('.queue-item.is-processing .queue-item-progress-bar');
                        if (modalProgressBar) {
                            modalProgressBar.style.width = `${overallPercent}%`;
                        }
                    }
                }
            });
        }
    },

    dispatchQueueUpdate() {
        document.dispatchEvent(new CustomEvent('downloadQueueUpdated'));
    },

    add(task) {
        task.totalTracks = 0;
        task.completedTracks = 0;
        if (task.type === 'track' || task.type === 'video') {
            task.totalTracks = 1; 
        }
        
        this.queue.push(task);
        this.updateQueueCount();
        this.dispatchQueueUpdate();
        if (!this.isProcessing) {
            this.processNext();
        }
    },

    async processNext() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            this.currentTask = null;
            sessionDirectoryHandle = null; 
            nativeSessionBasePath = null;
            updateDownloadManagerStatus({ albumTitle: '全部任务已完成', trackStatus: '队列已清空', autoHide: true });
            this.updateQueueCount();
            if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = '0%';
            this.dispatchQueueUpdate();
            return;
        }

        this.isProcessing = true;
        this.abortController = new AbortController();
        this.currentTask = this.queue.shift();
        
        if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = '0%'; 
        
        this.updateQueueCount();
        this.dispatchQueueUpdate();

        updateDownloadManagerStatus({ albumTitle: this.currentTask.name, trackStatus: '等待开始...' });

        try {
            await this.currentTask.taskFunc(this.abortController.signal, this);
        } catch (err) {
            if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = '0%';
            if (err.name === 'AbortError') {
                console.log(`任务 "${this.currentTask.name}" 已被用户取消。`);
                updateDownloadManagerStatus({ 
                    albumTitle: `已取消: ${this.currentTask.name}`, 
                    trackStatus: '正在准备下一个任务...', 
                    autoHide: false 
                });
            } else {
                console.error("下载任务失败:", err);
                updateDownloadManagerStatus({ 
                    trackStatus: `任务 "${this.currentTask.name}" 失败: ${err.message}`, 
                    autoHide: false
                });
            }
        }

        if (this.isProcessing) {
            this.processNext();
        }
    },

    updateQueueCount() {
        const count = this.queue.length + (this.isProcessing ? 1 : 0);
        dom.downloadQueueCount.textContent = count;
        dom.downloadQueueCount.classList.toggle('hidden', count === 0);
    },

    cancelTask(indexInQueue) {
        if (indexInQueue >= 0 && indexInQueue < this.queue.length) {
            const removed = this.queue.splice(indexInQueue, 1);
            console.log(`已从队列移除: ${removed[0].name}`);
            this.updateQueueCount();
            this.dispatchQueueUpdate();
        }
    },

    cancelCurrent() {
        console.log("正在取消当前任务...");
        if (this.isProcessing && this.abortController) {
            this.abortController.abort();
            if (window.electronAPI && this.currentTask && this.currentTask.trackId) {
                window.electronAPI.cancelDownload(this.currentTask.trackId);
            }
        }
    },
    
    cancelAll() {
        console.log("正在取消所有任务...");
        this.queue = [];
        this.cancelCurrent();
        this.updateQueueCount();
        this.dispatchQueueUpdate();
    }
};

downloadQueue.init();

async function getNativeSavePath() {
    if (nativeSessionBasePath) {
        return nativeSessionBasePath;
    }
    const path = await window.electronAPI.selectDirectory();
    if (path) {
        nativeSessionBasePath = path;
        return path;
    }
    updateDownloadManagerStatus({ trackStatus: '用户取消选择文件夹', autoHide: true });
    return null;
}

async function getWebAppDirectoryHandle() {
    if (sessionDirectoryHandle) return sessionDirectoryHandle;
    try {
        const handle = await window.showDirectoryPicker();
        sessionDirectoryHandle = handle;
        return handle;
    } catch (err) {
        if (err.name === 'AbortError') {
             updateDownloadManagerStatus({ trackStatus: '用户取消选择文件夹', autoHide: true });
        }
        return null;
    }
}

function parseMpdManifest(mpdContent) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(mpdContent, "application/xml");
    const initUrl = xmlDoc.querySelector('Representation SegmentTemplate')?.getAttribute('initialization');
    const mediaUrlTemplate = xmlDoc.querySelector('Representation SegmentTemplate')?.getAttribute('media');
    const segmentNodes = xmlDoc.querySelectorAll('SegmentTimeline S');
    if (!initUrl || !mediaUrlTemplate || !segmentNodes.length) throw new Error('MPD 清单解析失败');
    
    let totalSegments = 0;
    segmentNodes.forEach(node => { totalSegments += 1 + (parseInt(node.getAttribute('r') || '0', 10)); });
    
    return [initUrl, ...Array.from({ length: totalSegments }, (_, i) => mediaUrlTemplate.replace('$Number$', i + 1))];
}

export async function downloadAlbum(albumItem) {
    downloadQueue.add({
        name: albumItem.title,
        type: 'album',
        taskFunc: async (signal, queue) => { 
            updateDownloadManagerStatus({ 
                albumTitle: albumItem.title, 
                trackStatus: '正在获取曲目列表 (0/)...',
                autoHide: false 
            });

            let tracks;
            try {
                const data = await getAlbumTracksAPI(albumItem.id, (loaded, total) => {
                    if (queue.currentTask && queue.currentTask.name === albumItem.title) {
                        updateDownloadManagerStatus({ 
                            trackStatus: `正在获取曲目列表，曲目数量过大导致失败就多试几次 (${loaded}/${total || '?'})...`
                        });
                    }
                });
                tracks = data.tracks;
                
                if (!tracks || !tracks.length) {
                    throw new Error('专辑为空');
                }
            } catch (err) {
                console.error("获取专辑曲目列表失败:", err);
                throw new Error(`获取曲目列表失败: ${err.message}`);
            }

            queue.currentTask.totalTracks = tracks.length;
            queue.dispatchQueueUpdate(); 

            if (window.electronAPI) {
                await downloadAlbumNative(albumItem, tracks, signal, queue);
            } else if (window.showDirectoryPicker) {
                await downloadAlbumWeb(albumItem, tracks, signal, queue);
            } else {
                alert('您的浏览器不支持选择文件夹下载，将逐一保存到默认“下载”文件夹');
                for (let i = 0; i < tracks.length; i++) {
                    if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
                    updateDownloadManagerStatus({ trackStatus: `( ${i + 1}/${tracks.length} ) 正在下载: ${tracks[i].title}` });
                    await downloadTrackFallback(tracks[i].id, null, signal);
                    queue.currentTask.completedTracks++;
                }
            }
        }
    });
}

export function triggerDirectDownload(trackItem) {
    downloadQueue.add({
        name: trackItem.title,
        trackId: trackItem.id,
        type: 'track',
        taskFunc: async (signal, queue) => {
            updateDownloadManagerStatus({ albumTitle: trackItem.album?.title, trackStatus: `正在准备: ${trackItem.title}` });
            const info = await getDownloadInfo(trackItem.id, trackItem.trackNumber);
            if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
            if (window.electronAPI) {
                await downloadSingleTrackNative(info, signal, queue);
            } else if (window.showDirectoryPicker) {
                await downloadSingleTrackWeb(info, signal, queue);
            } else {
                await downloadTrackFallback(info, signal);
                queue.currentTask.completedTracks++;
            }
        }
    });
}

export function triggerDirectVideoDownload(videoItem) {
    downloadQueue.add({
        name: videoItem.title,
        trackId: videoItem.id,
        type: 'video',
        taskFunc: async (signal, queue) => {
            updateDownloadManagerStatus({ albumTitle: videoItem.title, trackStatus: `正在准备: ${videoItem.title}` });
            const info = await getVideoDownloadInfo(videoItem);
            if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
            
            if (window.electronAPI) {
                const basePath = await getNativeSavePath();
                if (!basePath) throw new DOMException('用户取消选择', 'AbortError');
                const artistName = sanitize(info.videoInfo.artist?.name || 'Unknown Artist');
                const videoFolderPath = simpleJoinPath(basePath, artistName, 'Videos');
                await window.electronAPI.downloadVideoTrack({
                    basePath: basePath,
                    videoInfo: info.videoInfo,
                    fileName: info.fileName,
                    diskCache: settingsManager.config.diskCache,
                    videoSegmentUrls: info.videoSegmentUrls,
                    audioSegmentUrls: info.audioSegmentUrls
                });
                
                queue.currentTask.completedTracks++;
                if (settingsManager.config.diskCache) {
                    await window.electronAPI.cleanupTrackTmpDir({ albumPath: videoFolderPath, trackId: info.videoInfo.id });
                }
                await window.electronAPI.cleanupAlbumTmpDir({ albumPath: videoFolderPath });
                
            } else if (window.showDirectoryPicker) {
                await downloadSingleVideoWeb(info, signal, queue);
                
            } else {
                updateDownloadManagerStatus({ trackStatus: `正在下载 (Fallback): ${info.fileName}` });
                const finalBuffer = await downloadVideoBuffer(info, null, signal);
                const blob = new Blob([finalBuffer], { type: 'video/mp4' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = info.fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(link.href);
                queue.currentTask.completedTracks++;
            }
        }
    });
}

async function downloadAlbumNative(albumItem, tracks, signal, queue) { 
    const basePath = await getNativeSavePath();
    if (!basePath) return;

    const folderParts = getFormattedPathParts(settingsManager.config.folderFormat, albumItem, albumItem.artists?.[0]);
    const albumPath = simpleJoinPath(basePath, ...folderParts);
    let hasFailures = false;

    updateDownloadManagerStatus({ trackStatus: `正在下载封面: cover.jpg` });
    try {
        const coverUrl = `https://resources.tidal.com/images/${albumItem.cover.replace(/-/g, '/')}/1280x1280.jpg`;
        const coverRes = await fetch(coverUrl, { signal });
        if (coverRes.ok) {
            const coverBuffer = await coverRes.arrayBuffer();
            await window.electronAPI.writeFile({ basePath, pathParts: [...folderParts, 'cover.jpg'], buffer: coverBuffer });
        }
    } catch (e) { if(e.name !== 'AbortError') console.warn("封面下载失败:", e); }

    for (let i = 0; i < tracks.length; i++) {
        if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        const track = tracks[i];
        queue.currentTask.trackId = track.id;
        try {
            updateDownloadManagerStatus({ trackStatus: `( ${i + 1}/${tracks.length} ) 正在准备: ${track.title}` });
            const info = await getDownloadInfo(track.id, null);
            
            let finalPathParts = [...folderParts];
            if (info.trackInfo.album?.numberOfVolumes > 1 && info.trackInfo.volumeNumber) {
                finalPathParts.push(`CD${info.trackInfo.volumeNumber}`);
            }
            finalPathParts.push(info.fileName);
            
            const finalBuffer = await downloadTrackBuffer(info, albumPath, signal);
            updateDownloadManagerStatus({ trackStatus: `正在保存: ${info.fileName}` });
            
            await window.electronAPI.writeFile({ basePath, pathParts: finalPathParts, buffer: finalBuffer });
            
            queue.currentTask.completedTracks++;
            
            if (settingsManager.config.diskCache) {
                await window.electronAPI.cleanupTrackTmpDir({ albumPath, trackId: track.id });
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            hasFailures = true; 
            console.error(`下载曲目 ${track.title} 失败:`, error);
            updateDownloadManagerStatus({ trackStatus: `下载失败: ${track.title} - ${error.message}`, autoHide: true });
        }
    }
    
    if (settingsManager.config.diskCache && !hasFailures) {
        await window.electronAPI.cleanupAlbumTmpDir({ albumPath });
    }
}

async function downloadSingleTrackNative(info, signal, queue) {
    const basePath = await getNativeSavePath();
    if (!basePath) return;

    const folderParts = getFormattedPathParts(settingsManager.config.folderFormat, info.trackInfo.album, info.trackInfo.artists?.[0]);
    const albumPath = simpleJoinPath(basePath, ...folderParts);
    
    try {
        let finalPathParts = [...folderParts];
        if (info.trackInfo.album?.numberOfVolumes > 1 && info.trackInfo.volumeNumber) {
            finalPathParts.push(`CD${info.trackInfo.volumeNumber}`);
        }
        finalPathParts.push(info.fileName);
            
        const finalBuffer = await downloadTrackBuffer(info, albumPath, signal);
        updateDownloadManagerStatus({ trackStatus: `正在保存: ${info.fileName}` });
        
        await window.electronAPI.writeFile({ basePath, pathParts: finalPathParts, buffer: finalBuffer });
        
        queue.currentTask.completedTracks++;

        if (settingsManager.config.diskCache) {
            await window.electronAPI.cleanupTrackTmpDir({ albumPath, trackId: info.trackInfo.id });
            await window.electronAPI.cleanupAlbumTmpDir({ albumPath });
        }
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error(`下载曲目 ${info.trackInfo.title} 失败:`, error);
        updateDownloadManagerStatus({ trackStatus: `下载失败: ${info.trackInfo.title} - ${error.message}`, autoHide: true });
    }
}

async function downloadAlbumWeb(albumItem, tracks, signal, queue) { 
    const rootHandle = await getWebAppDirectoryHandle();
    if (!rootHandle) return;

    const folderParts = getFormattedPathParts(settingsManager.config.folderFormat, albumItem, albumItem.artists?.[0]);
    let finalDirHandle = rootHandle;
    for (const part of folderParts) {
        if (part) finalDirHandle = await finalDirHandle.getDirectoryHandle(part, { create: true });
    }

    const tmpDirHandle = settingsManager.config.diskCache ? await finalDirHandle.getDirectoryHandle('tmp', { create: true }) : null;
    let hasFailures = false;

    updateDownloadManagerStatus({ trackStatus: `正在下载封面: cover.jpg` });
    try {
        const coverUrl = `https://resources.tidal.com/images/${albumItem.cover.replace(/-/g, '/')}/1280x1280.jpg`;
        const coverRes = await fetch(coverUrl, { signal });
        if(coverRes.ok) {
            const coverBlob = await coverRes.blob();
            const coverFileHandle = await finalDirHandle.getFileHandle('cover.jpg', { create: true });
            const writable = await coverFileHandle.createWritable();
            await writable.write(coverBlob);
            await writable.close();
        }
    } catch(e) { if(e.name !== 'AbortError') console.warn("封面下载失败:", e); }

    for (let i = 0; i < tracks.length; i++) {
        if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        const track = tracks[i];
        
        queue.currentTask.trackId = track.id; 

        let trackTmpDirHandle = null;
        if (tmpDirHandle) {
             trackTmpDirHandle = await tmpDirHandle.getDirectoryHandle(String(track.id), { create: true });
        }

        try {
            updateDownloadManagerStatus({ trackStatus: `( ${i + 1}/${tracks.length} ) 正在准备: ${track.title}` });
            const info = await getDownloadInfo(track.id, null);
            
            let saveDirHandle = finalDirHandle;
            if (info.trackInfo.album?.numberOfVolumes > 1 && info.trackInfo.volumeNumber) {
                saveDirHandle = await finalDirHandle.getDirectoryHandle(`CD${info.trackInfo.volumeNumber}`, { create: true });
            }
            
            const finalBuffer = await downloadTrackBuffer(info, trackTmpDirHandle, signal);
            
            const fileHandle = await saveDirHandle.getFileHandle(info.fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(finalBuffer);
            await writable.close();
            
            queue.currentTask.completedTracks++;

            updateDownloadManagerStatus({ trackStatus: `✔︎ 保存成功: ${info.fileName}`, autoHide: true });
            if (trackTmpDirHandle) await tmpDirHandle.removeEntry(String(track.id), { recursive: true });

        } catch (error) {
            if (error.name === 'AbortError') throw error;
            hasFailures = true;
            console.error(`下载曲目 ${track.title} 失败:`, error);
            updateDownloadManagerStatus({ trackStatus: `下载失败: ${track.title} - ${error.message}`, autoHide: true });
            if (tmpDirHandle) {
                const errorFileHandle = await tmpDirHandle.getFileHandle('error.txt', { create: true });
                const writable = await errorFileHandle.createWritable({ keepExistingData: true });
                await writable.seek(writable.size);
                const errorContent = `
-----------------------------------------
专辑名: ${albumItem.title}
专辑链接: https://tidal.com/album/${albumItem.id}
曲目名: ${String(i + 1).padStart(2, '0')}. ${track.title}
曲目链接: https://tidal.com/track/${track.id}
错误信息: ${error.message}
-----------------------------------------\n`;
                await writable.write(errorContent);
                await writable.close();
            }
        }
    }
    
    if (tmpDirHandle && !hasFailures) {
        await finalDirHandle.removeEntry('tmp', { recursive: true });
    }
}

async function downloadSingleTrackWeb(info, signal, queue) { 
    const rootHandle = await getWebAppDirectoryHandle();
    if (!rootHandle) return;

    let finalDirHandle = rootHandle;
    const folderParts = getFormattedPathParts(settingsManager.config.folderFormat, info.trackInfo.album, info.trackInfo.artists?.[0]);
    for (const part of folderParts) {
        if (part) finalDirHandle = await finalDirHandle.getDirectoryHandle(part, { create: true });
    }

    const tmpDirHandle = settingsManager.config.diskCache ? await finalDirHandle.getDirectoryHandle('tmp', { create: true }) : null;
    const trackTmpDirHandle = tmpDirHandle ? await tmpDirHandle.getDirectoryHandle(String(info.trackInfo.id), { create: true }) : null;

    try {
        let saveDirHandle = finalDirHandle;
        if (info.trackInfo.album?.numberOfVolumes > 1 && info.trackInfo.volumeNumber) {
            saveDirHandle = await finalDirHandle.getDirectoryHandle(`CD${info.trackInfo.volumeNumber}`, { create: true });
        }
            
        const finalBuffer = await downloadTrackBuffer(info, trackTmpDirHandle, signal);
        
        const fileHandle = await saveDirHandle.getFileHandle(info.fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(finalBuffer);
        await writable.close();
        
        queue.currentTask.completedTracks++;

        updateDownloadManagerStatus({ trackStatus: `✔︎ 保存成功: ${info.fileName}`, autoHide: true });
        if (trackTmpDirHandle) await tmpDirHandle.removeEntry(String(info.trackInfo.id), { recursive: true });
        if (tmpDirHandle) {
            const entries = await tmpDirHandle.values();
            let isEmpty = true;
            for await (const entry of entries) { isEmpty = false; break; }
            if (isEmpty) await finalDirHandle.removeEntry('tmp', { recursive: true });
        }
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error(`下载曲目 ${info.trackInfo.title} 失败:`, error);
        updateDownloadManagerStatus({ trackStatus: `下载失败: ${info.trackInfo.title} - ${error.message}`, autoHide: true });
    }
}

async function downloadSingleVideoWeb(info, signal, queue) { 
    const rootHandle = await getWebAppDirectoryHandle();
    if (!rootHandle) return;
    const artistName = sanitize(info.videoInfo.artist?.name || 'Unknown Artist');
    const artistDirHandle = await rootHandle.getDirectoryHandle(artistName, { create: true });
    const saveDirHandle = await artistDirHandle.getDirectoryHandle('Videos', { create: true });
    const trackTmpDirHandle = null; 

    try {
        const finalBuffer = await downloadVideoBuffer(info, trackTmpDirHandle, signal);
        const fileHandle = await saveDirHandle.getFileHandle(info.fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(finalBuffer);
        await writable.close();
        
        queue.currentTask.completedTracks++;
        updateDownloadManagerStatus({ trackStatus: `✔︎ 保存成功: ${info.fileName}`, autoHide: true });

    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error(`下载视频 ${info.videoInfo.title} 失败:`, error);
        updateDownloadManagerStatus({ trackStatus: `下载失败: ${info.videoInfo.title} - ${error.message}`, autoHide: true });
    }
}

function getFormattedPathParts(format, album, artist) {
    const populatedFormat = format
        .replace('{artist}', artist?.name || 'Unknown Artist')
        .replace('{album}', album?.title || 'Unknown Album')
        .replace('{year}', (album?.releaseDate || '').substring(0, 4));
    return populatedFormat.split(/[/\\]/).map(part => sanitize(part.trim())).filter(part => part.length > 0);
}

async function downloadTrackBuffer(info, pathOrHandle = null, signal) {
    await loadFFmpeg();
    updateDownloadManagerStatus({ trackStatus: `[${info.quality}] 开始下载: ${info.trackInfo.title}`});
    let originalBuffer;

    if (window.electronAPI) {
        const params = { 
            diskCache: settingsManager.config.diskCache,
            albumPath: pathOrHandle, 
            fileName: info.fileName,
            trackId: info.trackInfo.id,
        };
        if (info.type === 'hires') {
            params.segmentUrls = parseMpdManifest(info.manifest);
        } else {
            params.trackURL = info.url;
        }
        
        downloadQueue.currentTask.trackId = info.trackInfo.id;

        const result = info.type === 'hires'
            ? await window.electronAPI.downloadHiresTrack(params)
            : await window.electronAPI.downloadLosslessTrack(params);

        if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        if (!result.success) throw new Error(result.error);
        originalBuffer = result.buffer;
    } else {
        originalBuffer = info.type === 'hires'
            ? await downloadHiresSegmentsInBrowser(info, signal, pathOrHandle).then(mergeHiresSegments)
            : await downloadLosslessInBrowser(info, signal, pathOrHandle);
    }
    if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
    
    if (!window.electronAPI) {
        updateDownloadManagerStatus({ trackStatus: `正在写入元数据...` });
    }
    
    return await applyMetadata(originalBuffer, info.trackInfo);
}

async function downloadVideoBuffer(info, trackTmpDirHandle, signal) {
    await loadFFmpeg();
    updateDownloadManagerStatus({ trackStatus: `[${info.quality}] 开始下载视频: ${info.videoInfo.title}`});
    
    if (window.electronAPI) {
        throw new Error('downloadVideoBuffer 不应在 Electron 模式下被调用');
    } else {        
        const videoSegmentUrls = info.videoSegmentUrls;
        const audioSegmentUrls = info.audioSegmentUrls;
        const { completedTracks, totalTracks } = downloadQueue.currentTask;
        const totalSegments = videoSegmentUrls.length + audioSegmentUrls.length;
        let downloadedCount = 0;
        if (totalSegments === 0) throw new Error("M3U8中未找到任何分片");
        const updateProgress = () => {
            downloadedCount++;
            const trackPercent = Math.floor((downloadedCount / totalSegments) * 100);
            const overallPercent = ((completedTracks + trackPercent / 100) / totalTracks) * 100;
            updateDownloadManagerStatus({ trackStatus: `下载分片... (${downloadedCount}/${totalSegments})` });
            if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = `${overallPercent}%`;
            const modalProgressBar = dom.downloadQueueBody.querySelector('.queue-item.is-processing .queue-item-progress-bar');
            if (modalProgressBar) modalProgressBar.style.width = `${overallPercent}%`;
        };

        const downloadSegments = (urls, prefix) => {
            return downloadVideoSegmentsInBrowser(urls, prefix, signal, trackTmpDirHandle, updateProgress);
        };

        const [videoSegmentBuffers, audioSegmentBuffers] = await Promise.all([
            downloadSegments(videoSegmentUrls, 'v_'),
            downloadSegments(audioSegmentUrls, 'a_')
        ]);
        
        if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        
        updateDownloadManagerStatus({ trackStatus: '正在合并视频轨...' });
        const mergedVideoBuffer = await mergeVideoSegments(videoSegmentBuffers, 'v_');

        let finalBuffer;
        if (audioSegmentBuffers.length > 0) {
            updateDownloadManagerStatus({ trackStatus: '正在合并音频轨...' });
            const mergedAudioBuffer = await mergeVideoSegments(audioSegmentBuffers, 'a_');
            
            if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
            
            updateDownloadManagerStatus({ trackStatus: '正在混合音视频...' });
            finalBuffer = await muxVideoAndAudio(mergedVideoBuffer, mergedAudioBuffer);
        } else {
            finalBuffer = mergedVideoBuffer;
        }

        return finalBuffer;
    }
}


async function downloadTrackFallback(trackIdOrInfo, trackNumber, signal) {
    const info = typeof trackIdOrInfo === 'object' ? trackIdOrInfo : await getDownloadInfo(trackIdOrInfo, trackNumber);
    if (!info) throw new Error(`无法获取歌曲信息`);
    
    if (downloadQueue.currentTask && !downloadQueue.currentTask.trackId) {
        downloadQueue.currentTask.trackId = info.trackInfo.id;
    }

    const finalBuffer = await downloadTrackBuffer(info, null, signal);
    const blob = new Blob([finalBuffer], { type: 'audio/flac' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = info.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    await new Promise(resolve => setTimeout(resolve, 200));
}

async function downloadHiresSegmentsInBrowser(info, signal, trackTmpDirHandle) {
    const allUrls = parseMpdManifest(info.manifest);
    const maxConcurrency = settingsManager.config.hiresThreads;
    const segmentBuffers = new Array(allUrls.length);
    let downloadedCount = 0;

    const { completedTracks, totalTracks } = downloadQueue.currentTask;

    async function downloadSegmentWithRetry(url, index) {
        if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        const segmentFileName = `segment_${String(index).padStart(4, '0')}.m4a`;
        if (trackTmpDirHandle) {
            try {
                const fileHandle = await trackTmpDirHandle.getFileHandle(segmentFileName);
                const file = await fileHandle.getFile();
                segmentBuffers[index] = await file.arrayBuffer();
                downloadedCount++;
                
                const trackPercent = Math.floor((downloadedCount / allUrls.length) * 100);
                const overallPercent = ((completedTracks + trackPercent / 100) / totalTracks) * 100;
                updateDownloadManagerStatus({ trackStatus: `从缓存加载分片 (${downloadedCount}/${allUrls.length})` });
                if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = `${overallPercent}%`;
                const modalProgressBarCached = dom.downloadQueueBody.querySelector('.queue-item.is-processing .queue-item-progress-bar');
                if (modalProgressBarCached) modalProgressBarCached.style.width = `${overallPercent}%`;
                return;
            } catch (e) { /* Not in cache */ }
        }
        for (let i = 0; i < 3; i++) {
            try {
                const response = await fetch(url, { signal });
                if (!response.ok) throw new Error(`分片下载失败: ${response.status}`);
                const buffer = await response.arrayBuffer();
                segmentBuffers[index] = buffer;
                if (trackTmpDirHandle) {
                    const fileHandle = await trackTmpDirHandle.getFileHandle(segmentFileName, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(buffer);
                    await writable.close();
                }
                downloadedCount++;

                const trackPercent = Math.floor((downloadedCount / allUrls.length) * 100);
                const overallPercent = ((completedTracks + trackPercent / 100) / totalTracks) * 100;
                updateDownloadManagerStatus({ trackStatus: `下载分片... (${downloadedCount}/${allUrls.length})` });
                if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = `${overallPercent}%`;
                const modalProgressBar = dom.downloadQueueBody.querySelector('.queue-item.is-processing .queue-item-progress-bar');
                if (modalProgressBar) modalProgressBar.style.width = `${overallPercent}%`;
                return;
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError') throw error;
                console.warn(`下载分片 ${index} 失败 (第 ${i + 1} 次尝试):`, error.message);
                if (i === 2) throw error;
                await new Promise(res => setTimeout(res, 1500));
            }
        }
    }
    
    const promises = [];
    for (let i = 0; i < allUrls.length; i++) {
        promises.push(downloadSegmentWithRetry(allUrls[i], i));
        if (promises.length >= maxConcurrency) {
            await Promise.all(promises);
            promises.length = 0; 
        }
    }
    await Promise.all(promises);
    return segmentBuffers;
}

async function downloadVideoSegmentsInBrowser(allUrls, filePrefix, signal, trackTmpDirHandle, onProgress) {
    const maxConcurrency = settingsManager.config.hiresThreads;
    const segmentBuffers = new Array(allUrls.length);

    async function downloadSegmentWithRetry(url, index) {
        if (signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        for (let i = 0; i < 3; i++) {
            try {
                const response = await fetch(url, { signal });
                if (!response.ok) throw new Error(`分片下载失败: ${response.status}`);
                const buffer = await response.arrayBuffer();
                segmentBuffers[index] = buffer;
                onProgress();
                return;
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError') throw error;
                console.warn(`下载分片 ${index} 失败 (第 ${i + 1} 次尝试):`, error.message);
                if (i === 2) throw error;
                await new Promise(res => setTimeout(res, 1500));
            }
        }
    }
    
    const promises = [];
    for (let i = 0; i < allUrls.length; i++) {
        promises.push(downloadSegmentWithRetry(allUrls[i], i));
        if (promises.length >= maxConcurrency) {
            await Promise.all(promises);
            promises.length = 0; 
        }
    }
    await Promise.all(promises);
    return segmentBuffers.filter(Boolean);
}


async function downloadLosslessInBrowser(info, signal, trackTmpDirHandle) {
    const partFileName = `${info.fileName}.part`;
    let startOffset = 0;

    const { completedTracks, totalTracks } = downloadQueue.currentTask;

    if (trackTmpDirHandle) {
        try {
            const fileHandle = await trackTmpDirHandle.getFileHandle(partFileName);
            const file = await fileHandle.getFile();
            startOffset = file.size;
        } catch (e) { /* Not in cache */ }
    }
    
    const headRes = await fetch(info.url, { method: 'HEAD', signal });
    const fullFileSize = parseInt(headRes.headers.get('content-length'), 10);
    if (trackTmpDirHandle && startOffset > 0 && startOffset === fullFileSize) {
         const fileHandle = await trackTmpDirHandle.getFileHandle(partFileName);
         const file = await fileHandle.getFile();
         return file.arrayBuffer();
    }

    const headers = {};
    if (startOffset > 0) headers['Range'] = `bytes=${startOffset}-`;

    const response = await fetch(info.url, { headers, signal });
    if (!response.ok) throw new Error(`下载失败，状态码: ${response.status}`);

    const reader = response.body.getReader();
    
    if (trackTmpDirHandle) {
        const fileHandle = await trackTmpDirHandle.getFileHandle(partFileName, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: true });
        await writable.seek(startOffset);
        
        let lastProgressTime = Date.now();
        let receivedBytesInSession = 0;
        let lastReceivedBytes = 0;

        while (true) {
            if (signal.aborted) {
                reader.cancel();
                await writable.close();
                throw new DOMException('下载已取消', 'AbortError');
            }
            const { done, value } = await reader.read();
            if (done) break;
            await writable.write(value);
            receivedBytesInSession += value.length;

            const now = Date.now();
            const timeDiff = (now - lastProgressTime) / 1000;

            if (timeDiff >= 1 || done) {
                const bytesSinceLastUpdate = receivedBytesInSession - lastReceivedBytes;
                const speed = bytesSinceLastUpdate / timeDiff;
                const speedText = `${(speed / 1024 / 1024).toFixed(2)} MB/s`;
                
                if (fullFileSize > 0) {
                    const totalReceived = startOffset + receivedBytesInSession;
                    const trackPercent = Math.floor((totalReceived / fullFileSize) * 100);
                    
                    const overallPercent = ((completedTracks + trackPercent / 100) / totalTracks) * 100;
                    updateDownloadManagerStatus({ trackStatus: `下载中... (${trackPercent}%) ${speedText}`});
                    if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = `${overallPercent}%`;
                    const modalProgressBar = dom.downloadQueueBody.querySelector('.queue-item.is-processing .queue-item-progress-bar');
                    if (modalProgressBar) modalProgressBar.style.width = `${overallPercent}%`;

                } else {
                    updateDownloadManagerStatus({ trackStatus: `下载中... ${speedText}`});
                }
                
                lastProgressTime = now;
                lastReceivedBytes = receivedBytesInSession;
            }
        }
        await writable.close();
        
        const finalFile = await fileHandle.getFile();
        return finalFile.arrayBuffer();
    } else {
        const chunks = [];
        let receivedBytes = 0;
        
        let lastProgressTime = Date.now();
        let lastReceivedBytes = 0;

        while (true) {
             if (signal.aborted) {
                reader.cancel();
                throw new DOMException('下载已取消', 'AbortError');
            }
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            receivedBytes += value.length;
            
            const now = Date.now();
            const timeDiff = (now - lastProgressTime) / 1000;

            if (timeDiff >= 1 || done) {
                const bytesSinceLastUpdate = receivedBytes - lastReceivedBytes;
                const speed = bytesSinceLastUpdate / timeDiff;
                const speedText = `${(speed / 1024 / 1024).toFixed(2)} MB/s`;
                
                if(fullFileSize > 0) {
                     const trackPercent = Math.floor((receivedBytes/fullFileSize) * 100);
                     
                     const overallPercent = ((completedTracks + trackPercent / 100) / totalTracks) * 100;
                     updateDownloadManagerStatus({ trackStatus: `下载中... (${trackPercent}%) ${speedText}`});
                     if (dom.downloadProgressBar) dom.downloadProgressBar.style.width = `${overallPercent}%`;
                     const modalProgressBar = dom.downloadQueueBody.querySelector('.queue-item.is-processing .queue-item-progress-bar');
                     if (modalProgressBar) modalProgressBar.style.width = `${overallPercent}%`;
                } else {
                    updateDownloadManagerStatus({ trackStatus: `下载中... ${speedText}`});
                }

                lastProgressTime = now;
                lastReceivedBytes = receivedBytes;
            }
        }
        const blob = new Blob(chunks);
        return blob.arrayBuffer();
    }
}

async function getDownloadInfo(trackId, trackNumber = null) {
    try {
        const trackInfo = await getItemInfoAPI('track', trackId);
        if (!trackInfo) throw new Error('无法获取曲目详情');
        if (trackInfo.album?.id) {
            try {
                const albumDetails = await getItemInfoAPI('album', trackInfo.album.id);
                if (albumDetails) Object.assign(trackInfo.album, albumDetails);
            } catch (albumErr) { console.warn(`无法获取专辑 ${trackInfo.album.id} 的额外详情。`); }
        }

        if (settingsManager.config.metadataFields.lyrics) {
            try {
                trackInfo.lyrics = await getLyricsAPI(trackId);
            } catch (lyricsErr) {
                console.warn(`获取歌词失败 (ID: ${trackId}):`, lyricsErr.message);
                trackInfo.lyrics = null;
            }
        }

        const format = settingsManager.config.filenameFormat;
        const finalTrackNumber = trackNumber ?? trackInfo.trackNumber ?? '';
        const fileName = format
            .replace('{trackNumber}', String(finalTrackNumber).padStart(2, '0'))
            .replace('{title}', sanitize(trackInfo.title))
            .replace('{artist}', sanitize(trackInfo.artist?.name || trackInfo.artists?.[0]?.name))
            .replace('{album}', sanitize(trackInfo.album?.title));

        if (settingsManager.config.downloadHires && trackInfo.mediaMetadata?.tags?.includes('HIRES_LOSSLESS')) {
            try {
                const manifestRes = await fetch(`/dash?id=${trackId}&quality=HI_RES_LOSSLESS`);
                if (!manifestRes.ok) throw new Error('Hi-Res 清单获取失败');
                return {
                    type: 'hires', quality: 'Hi-Res', manifest: await manifestRes.text(),
                    fileName: `${fileName || 'download'}.flac`, trackInfo: trackInfo
                };
            } catch (e) { console.warn("Hi-Res 下载失败，自动回退到 Lossless", e); }
        }
        
        const data = await getTrackInfo(trackId);
        const audioUrl = data && data[2] ? data[2].OriginalTrackUrl : null;
        if (!audioUrl) throw new Error('无法从 getTrackInfo 获取 Lossless URL');
        
        return {
            type: 'lossless', quality: 'Lossless', url: audioUrl,
            fileName: `${fileName || 'download'}.flac`, trackInfo: trackInfo 
        };
    } catch (err) {
        console.error(`下载准备失败 (ID: ${trackId})`, err);
        throw err;
    }
}

async function getVideoDownloadInfo(videoItem) {
    try {
        const manifestJson = await getVideoPlaybackInfoAPI(videoItem.id);
        const m3u8Url = manifestJson.urls[0];
        if (!m3u8Url) throw new Error("Manifest JSON 中未找到 URL");
        const fileName = `${sanitize(videoItem.title || 'video')}.mp4`;
        const masterM3u8Res = await fetch(m3u8Url);
        if (!masterM3u8Res.ok) throw new Error(`获取主M3U8失败: ${masterM3u8Res.status}`);
        const masterM3u8Content = await masterM3u8Res.text();
        const { videoUrl, audioUrl } = parseMasterM3u8(masterM3u8Content, m3u8Url);
        if (!videoUrl) throw new Error('无法从 Master M3U8 中解析视频流');
        const videoM3u8Res = await fetch(videoUrl);
        if (!videoM3u8Res.ok) throw new Error(`获取视频M3U8失败: ${videoM3u8Res.status}`);
        const videoM3u8Content = await videoM3u8Res.text();
        let audioM3u8Content = null;
        if (audioUrl) {
            try {
                const audioM3u8Res = await fetch(audioUrl);
                if (audioM3u8Res.ok) {
                    audioM3u8Content = await audioM3u8Res.text();
                }
            } catch (e) { /* ignore, will be handled later */ }
        }

        const videoSegmentUrls = parseVariantM3u8(videoM3u8Content, videoUrl);
        const audioSegmentUrls = audioM3u8Content ? parseVariantM3u8(audioM3u8Content, audioUrl) : [];
        return {
            type: 'video',
            quality: videoItem.quality || 'HIGH',
            m3u8Url: m3u8Url,
            fileName: fileName,
            videoInfo: videoItem,
            videoSegmentUrls: videoSegmentUrls,
            audioSegmentUrls: audioSegmentUrls
        };
    } catch (err) {
        console.error(`视频准备失败 (ID: ${videoItem.id})`, err);
        throw err;
    }
}

function parseMasterM3u8(content, baseUrl) {
    const lines = content.split('\n');
    const baseUri = new URL(baseUrl);
    
    let videoUrl = null;
    let audioUrl = null;

    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch && uriMatch[1]) {
                audioUrl = new URL(uriMatch[1], baseUri).href;
                break;
            }
        }
    }
    
    let bestBandwidth = 0;
    let bestVideoUrl = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
            if (bandwidthMatch && bandwidthMatch[1]) {
                const bandwidth = parseInt(bandwidthMatch[1], 10);
                if (lines[i+1] && !lines[i+1].startsWith('#')) {
                    if (bandwidth > bestBandwidth) {
                        bestBandwidth = bandwidth;
                        bestVideoUrl = new URL(lines[i+1].trim(), baseUri).href;
                    }
                }
            }
        }
    }
    
    videoUrl = bestVideoUrl;
    if (!videoUrl) {
        let hasSegments = false;
        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                hasSegments = true;
                break;
            }
        }
        if (hasSegments) {
            videoUrl = baseUrl;
        }
    }
    
    return { videoUrl, audioUrl };
}

function parseVariantM3u8(content, baseUrl) {
    const lines = content.split('\n');
    const baseUri = new URL(baseUrl);
    const segmentUrls = [];

    let baseSegmentPath = '';
    for (const line of lines) {
         if (line.startsWith('#EXT-X-MAP:URI=')) {
             const uriMatch = line.match(/URI="([^"]+)"/);
             if (uriMatch && uriMatch[1]) {
                const mapUrl = new URL(uriMatch[1], baseUri);
                baseSegmentPath = mapUrl.href.substring(0, mapUrl.href.lastIndexOf('/') + 1);
                break;
             }
         }
    }
    if (!baseSegmentPath) {
        baseSegmentPath = baseUri.href.substring(0, baseUri.href.lastIndexOf('/') + 1);
    }


    for (const line of lines) {
        if (line.length > 0 && !line.startsWith('#')) {
            segmentUrls.push(new URL(line.trim(), baseSegmentPath).href);
        }
    }
    return segmentUrls;
}
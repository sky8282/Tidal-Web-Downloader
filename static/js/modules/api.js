// js/modules/api.js

const API_BASE_URL = '';

export async function getModulePagedDataAPI(path, offset, limit) {
    const res = await fetch(`${API_BASE_URL}/module-paged-data/${path}?offset=${offset}&limit=${limit}`);
    if (!res.ok) throw new Error(`无法获取模块分页数据: ${path}`);
    return res.json();
}

export async function getHomeContentAPI() {
    const res = await fetch(`${API_BASE_URL}/home`);
    if (!res.ok) throw new Error('无法获取主页内容');
    return res.json();
}

export async function searchAPI(type, query, offset) {
    const res = await fetch(`${API_BASE_URL}/search?${type}=${encodeURIComponent(query)}&limit=25&offset=${offset}`);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    return res.json();
}

export async function getItemInfoAPI(itemType, itemId) {
    const url = `${API_BASE_URL}/item/${itemType}/${itemId}`;
    const retries = 3;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                if (res.status >= 400 && res.status < 500) {
                     throw new Error(`无法获取项目'${itemId}'详情 (Client Error ${res.status})`);
                }
                throw new Error(`无法获取项目'${itemId}'详情 (Server Error ${res.status})`); 
            }
            return res.json();
        } catch (err) {
            if (i === retries - 1) {
                 console.error(`getItemInfoAPI 最终失败 (url: ${url}): ${err.message}`);
                 throw err; 
            }
            console.warn(`getItemInfoAPI 失败 (url: ${url}), ${1000}ms 后重试... (Attempt ${i + 2}/${retries})`);
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

export async function getAlbumTracksAPI(albumId, onProgress = () => {}) { 
    let total = 0;
    try {
        const albumDetails = await getItemInfoAPI('album', albumId); 
        if (albumDetails && albumDetails.numberOfTracks) {
            total = albumDetails.numberOfTracks;
        } else {
            console.warn(`无法获取专辑 ${albumId} 的曲目总数, 翻页可能不完整`);
        }
        onProgress(0, total); 
    } catch (e) {
        console.error(`获取专辑详情失败: ${e.message}`);
        throw new Error(`无法获取专辑详情: ${albumId}`);
    }

    if (total === 0) {
        console.log(`专辑 ${albumId} 曲目总数为 0.`);
        onProgress(0, 0); 
        return { tracks: [] };
    }

    let allTracks = [];
    let offset = 0;
    const limit = 100; 
    const retries = 3;

    do {
        for (let i = 0; i < retries; i++) {
            const url = `${API_BASE_URL}/album/${albumId}/tracks?offset=${offset}&limit=${limit}`;
            try {
                const res = await fetch(url); 
                if (!res.ok) {
                     if (res.status >= 400 && res.status < 500) {
                        throw new Error(`Client Error ${res.status}`);
                     }
                     throw new Error(`Server Error ${res.status}`);
                }
                
                const data = await res.json();
                if (data && data.items && data.items.length > 0) {
                    allTracks = allTracks.concat(data.items);
                    offset += data.items.length;
                    onProgress(allTracks.length, total); 
                } else if (data && data.tracks && data.tracks.length > 0) {
                    allTracks = allTracks.concat(data.tracks);
                    offset += data.tracks.length;
                    onProgress(allTracks.length, total);
                } else {
                    total = allTracks.length;
                }
                
                break;
                
            } catch (err) {
                 if (i === retries - 1) {
                    console.error(`获取专辑曲目分页失败 (url: ${url}, 已重试): ${err.message}. 将仅下载已获取的 ${allTracks.length} 首曲目.`);
                    total = allTracks.length;
                 } else {
                    console.warn(`获取专辑曲目分页失败 (url: ${url}), ${1000}ms 后重试... (Attempt ${i + 2}/${retries})`);
                    await new Promise(res => setTimeout(res, 1000));
                 }
            }
        }

    } while (allTracks.length < total);

    if (allTracks.length > total) {
        allTracks = allTracks.slice(0, total);
    }
    
    onProgress(allTracks.length, total); 
    return { tracks: allTracks };
}

export async function getArtistDetailsAPI(artistId) {
    const res = await fetch(`${API_BASE_URL}/artist?f=${artistId}`);
    if (!res.ok) throw new Error('API请求失败');
    return res.json();
}

export async function getTrackInfo(trackId) {
    const res = await fetch(`${API_BASE_URL}/track?id=${trackId}&quality=LOSSLESS`);
    if (!res.ok) throw new Error(`无法获取ID为${trackId}的歌曲信息`);
    return res.json();
}

export async function getLyricsAPI(trackId) {
    const res = await fetch(`${API_BASE_URL}/lyrics?id=${trackId}`);
    if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`无法获取歌词 (ID: ${trackId}): ${res.status}`);
    }
    const data = await res.json();
    if (data && data.length > 0 && data[0].lyrics) {
        return data[0].lyrics;
    }
    return null;
}

export async function getVideoPlaybackInfoAPI(videoId) {
    const res = await fetch(`${API_BASE_URL}/video-playback-info?id=${videoId}`);
    if (!res.ok) {
        let errorText = res.statusText;
        try {
            errorText = await res.text();
        } catch(e) {}
        throw new Error(`无法获取视频播放信息 (ID: ${videoId}): ${res.status} - ${errorText}`);
    }
    return res.json();
}
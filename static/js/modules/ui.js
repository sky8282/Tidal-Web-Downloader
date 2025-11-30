// js/modules/ui.js

import * as dom from './dom.js';
import { player } from './player.js';
import { getAlbumTracksAPI, getArtistDetailsAPI } from './api.js';
import { downloadAlbum, triggerDirectDownload, downloadQueue } from './downloader.js';
import { copyTextToClipboard } from './utils.js';

export function updatePlayerUI() {
    document.querySelectorAll('.card').forEach(card => {
        card.classList.remove('is-active-album', 'is-playing');
        const playBtn = card.querySelector('.card-play-btn');
        if (playBtn) playBtn.classList.remove('is-playing');
    });

    if (!player.currentTrack) {
        updateGlobalPlayerState();
        return;
    }

    let selector = player.currentAlbumId ? `.card[data-album-id="${player.currentAlbumId}"]` : `.card[data-track-id="${player.currentTrack.id}"]`;
    document.querySelectorAll(selector).forEach(card => {
        card.classList.add('is-active-album');
        if (player.isPlaying) {
            card.classList.add('is-playing');
            const playBtn = card.querySelector('.card-play-btn');
            if (playBtn) playBtn.classList.add('is-playing');
        }
    });
    updateGlobalPlayerState();
}

function updateGlobalPlayerState() {
    const playPauseBtn = dom.playPauseBtn;
    playPauseBtn.className = 'player-btn large';
    playPauseBtn.disabled = !player.currentTrack && !player.isLoading;

    if (player.isLoading) playPauseBtn.classList.add('is-loading');
    else if (player.isPlaying) playPauseBtn.classList.add('is-playing');
    
    if (player.currentTrack) {
        dom.globalPlayer.style.display = 'block';
        const cover = player.currentTrack?.album?.cover;
        dom.playerAlbumArt.src = cover ? `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/320x320.jpg` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    } else {
        dom.globalPlayer.style.display = 'none';
    }
    dom.nextBtn.disabled = !player.hasNext();
    dom.prevBtn.disabled = !player.hasPrev();
}

export function updateTrackListUI() {
    dom.tracklistModalBody.querySelectorAll('.track-list-item').forEach(el => {
        el.classList.remove('is-playing');
        const btn = el.querySelector('.play-btn');
        if (btn) btn.classList.remove('is-playing');
    });

    dom.tracklistModalBody.querySelectorAll('.track-progress-bar-container').forEach(el => el.remove());
    
    if (player.currentTrack && dom.tracklistModal.classList.contains('is-visible')) {
        const item = dom.tracklistModalBody.querySelector(`[data-track-id="${player.currentTrack.id}"]`);
        if (item) {
            item.classList.add('is-playing');
            if (player.isPlaying) {
                const btn = item.querySelector('.play-btn');
                if (btn) btn.classList.add('is-playing');
            }
            const progressContainer = document.createElement('div');
            progressContainer.className = 'track-progress-bar-container';
            progressContainer.innerHTML = `<input type="range" class="track-progress-bar" value="0" step="0.1">`;
            
            const bar = progressContainer.firstChild;
            const audioEl = dom.playerAudioElement;
            if (audioEl && audioEl.duration > 0) {
                bar.value = (audioEl.currentTime / audioEl.duration) * 100;
            }
            bar.addEventListener('input', e => player.seek(e.target.value));
            item.appendChild(progressContainer);
        }
    }
}

export function displayHomepage(modules) {
    dom.resultsWall.innerHTML = '';
    const module = modules[0];
    if (!module) return;

    const currentItems = module.pagedList?.items || module.items;
    if (!currentItems || currentItems.length === 0) return;

    const wallId = 'homepage-wall';
    const wall = document.createElement('div');
    wall.className = 'cover-wall';
    wall.id = wallId;
    dom.resultsWall.appendChild(wall);

    appendResultsToWall(wallId, currentItems, module.type);
    const pagedList = module.pagedList;
    const dataPath = module.showMore?.apiPath || pagedList?.dataApiPath;
    if (pagedList && dataPath && pagedList.items.length < pagedList.totalNumberOfItems) {
        const sentinel = document.createElement('div');
        sentinel.className = 'load-more-sentinel';
        sentinel.dataset.modulePath = dataPath;
        sentinel.dataset.limit = pagedList.limit;
        const currentOffset = pagedList.offset || 0;
        const currentItemCount = pagedList.items.length;
        sentinel.dataset.offset = currentOffset + currentItemCount; 

        sentinel.dataset.total = pagedList.totalNumberOfItems;
        sentinel.dataset.wallId = wallId;
        sentinel.dataset.moduleType = module.type;
        sentinel.innerHTML = `<div class="loader"></div>`;
        dom.resultsWall.appendChild(sentinel);
    }
}

export function appendResultsToWall(wallId, items, moduleType) {
    const wall = document.getElementById(wallId);
    if (!wall) return;
    
    const isAlbumList = moduleType.includes('ALBUM');
    const isPlaylist = moduleType.includes('PLAYLIST');
    
    const fullList = Array.from(wall.children).map(card => card.dataset.item);
    
    items.forEach((itemData, index) => {
        const item = itemData.item || itemData;
        let cardType = 'track';
        if (isAlbumList) cardType = 'album';
        if (isPlaylist) {
            cardType = 'playlist';
            item.cover = item.image || item.squareImage;
        }
        const card = createCard(item, fullList, cardType, wall.children.length + index);
        card.dataset.item = JSON.stringify(item);
        wall.appendChild(card);
    });
}

export function displayResults(results, searchType, clear = true, currentPage = 0) {
    if (clear) dom.resultsWall.innerHTML = '';
    
    let items = [], cardType = 'track';
    switch (searchType) {
        case 'al': items = results.albums?.items || results.items || []; cardType = 'album'; break;
        case 's': items = results.items || []; cardType = 'track'; break;
        case 'a': items = results.artists?.items || []; cardType = 'artist'; break;
        default: items = [];
    }
    items = items.filter(Boolean);

    if (currentPage === 0 && items.length === 0) {
        dom.resultsWall.innerHTML = '<p>未找到结果</p>';
    } else {
        const wallId = "search-results-wall";
        if (clear) {
             const wall = document.createElement('div');
             wall.className = 'cover-wall';
             wall.id = wallId;
             dom.resultsWall.appendChild(wall);
        }
        appendResultsToWall(wallId, items, searchType === 'al' ? 'ALBUM_LIST' : 'TRACK_LIST');
    }
    return items.length >= 25;
}

function getBadgeText(tags) {
    if (!Array.isArray(tags)) return null;
    const hasHires = tags.includes('HIRES_LOSSLESS');
    const has360 = tags.includes('DOLBY_ATMOS');
    if (hasHires && has360) return 'H/A';
    if (hasHires) return 'H';
    if (has360) return 'A';
    return null;
}

function createCard(item, fullList, cardType, index) {
    const card = document.createElement('div'); card.className = 'card';
    const isAlbum = cardType === 'album';
    const isPlaylist = cardType === 'playlist';

    const cover = item.cover || item.picture || item?.album?.cover;
    const coverId = cover ? cover.replace(/-/g, '/') : null;
    const coverUrl = coverId ? `https://resources.tidal.com/images/${coverId}/320x320.jpg` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    
    const title = item.title || item.name || '';
    const artist = item.artist || (item.artists ? item.artists[0] : null);
    
    if (isAlbum) card.dataset.albumId = item.id;
    else if (cardType === 'track') card.dataset.trackId = item.id;
    else if (isPlaylist) card.dataset.playlistId = item.uuid;
    
    const badgeText = getBadgeText(item.mediaMetadata?.tags);

    const dlIcon = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>`;
    const expandIcon = `<svg viewBox="0 0 24 24"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"></path></svg>`;
    const artistIcon = `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"></path></svg>`;
    const copyUrlIcon = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>`;
    const copyNameIcon = `<svg viewBox="0 0 24 24"><path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"></path></svg>`;
    
    card.innerHTML = `
        <div class="img-container">
            ${badgeText ? `<div class="card-badge">${badgeText}</div>` : ''}
            <img src="${coverUrl}" alt="${title}" loading="lazy">
            <div class="card-actions">
                <div class="card-actions-top"><div class="card-metadata-overlay"></div><div class="card-actions-top-right">${artist ? `<button class="action-artist" title="查看歌手">${artistIcon}</button>`: ''}</div></div>
                <div class="card-actions-bottom">
                    <button class="action-copy-url" title="复制链接">${copyUrlIcon}</button>
                    <button class="action-copy-name" title="复制标题">${copyNameIcon}</button>
                    ${cardType !== 'artist' && !isPlaylist ? `<button class="action-download" title="下载">${dlIcon}</button>` : ''}
                    ${isAlbum ? `<button class="action-expand" title="查看曲目">${expandIcon}</button>` : ''}
                </div>
            </div>
        </div>
        <div class="card-info">
             <div class="card-title-row">
                <h3>${title}</h3>
                ${cardType !== 'artist' && !isPlaylist ? `
                <button class="card-play-btn" title="播放">
                    <svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>
                    <svg class="pause-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>
                </button>` : `<div class="card-play-btn-placeholder"></div>`}
            </div>
            ${!artist && cardType !== 'artist' ? `<p class="card-subtitle">${item.description || ''}</p>` : ''}
        </div>`;
    
    const metadataOverlay = card.querySelector('.card-metadata-overlay');
    if (isAlbum && item.numberOfTracks) {
        const duration = item.duration ? new Date(item.duration * 1000).toISOString().substr(14, 5) : '';
        metadataOverlay.innerHTML = `<span>曲目：${item.numberOfTracks}</span><span>时长：${duration}</span>`;
    } else if (cardType === 'track') {
        const artistName = artist?.name || '';
        const quality = (item.audioQuality?.replace('_LOSSLESS', '')?.replace('_', ' ') || '');
        metadataOverlay.innerHTML = `<span>${artistName}</span><span>${quality}</span>`;
    } else if (isPlaylist && item.numberOfTracks) {
         metadataOverlay.innerHTML = `<span>曲目：${item.numberOfTracks}</span>`;
    }
    
    if (artist) {
      const artistIdToShow = (item.artists && item.artists[0]) ? item.artists[0].id : artist.id;
      card.querySelector('.action-artist')?.addEventListener('click', e => { e.stopPropagation(); showArtistModal(artistIdToShow); });
    }
    
    card.querySelector('.action-copy-url').addEventListener('click', e => { e.stopPropagation(); copyTextToClipboard(item.url || `https://tidal.com/browse/${cardType}/${item.id || item.uuid}`, e.currentTarget); });
    card.querySelector('.action-copy-name').addEventListener('click', e => { e.stopPropagation(); copyTextToClipboard(title, e.currentTarget); });
    
    if (cardType === 'track' || cardType === 'album') {
        const playBtn = card.querySelector('.card-play-btn');
        if (playBtn) {
            playBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (isAlbum) {
                    if (player.currentAlbumId === item.id) player.togglePlayPause();
                    else startAlbumPlayback(item.id);
                } else {
                    if (player.currentTrack && player.currentTrack.id === item.id) player.togglePlayPause();
                    else {
                        player.tracklist = fullList.map(cardItem => JSON.parse(cardItem));
                        player.playTrackAtIndex(index, item.album?.id);
                    }
                }
            });
        }
        const downloadBtn = card.querySelector('.action-download');
        if(downloadBtn) downloadBtn.addEventListener('click', e => { e.stopPropagation(); isAlbum ? downloadAlbum(item) : triggerDirectDownload(item); });
    }
    if (isAlbum) card.querySelector('.action-expand').addEventListener('click', e => { e.stopPropagation(); showTrackListInModal(item, title, coverUrl); });
    if (cardType === 'artist') card.addEventListener('click', (e) => { e.stopPropagation(); showArtistModal(item.id); });
    return card;
}

export async function showTrackListInModal(albumItem, albumName, coverUrl) {
    dom.tracklistModal.classList.add('is-visible');
    document.body.classList.add('modal-open');
    if (dom.artistModal.classList.contains('is-visible')) dom.artistModal.classList.add('is-covered');

    dom.tracklistModalTitle.textContent = albumName;
    dom.modalAlbumArt.src = coverUrl;
    dom.modalDownloadAlbumBtn.onclick = () => downloadAlbum(albumItem);
    dom.tracklistModalBody.innerHTML = '<p>正在加载曲目...</p>';
    try {
        const { tracks } = await getAlbumTracksAPI(albumItem.id);
        dom.tracklistModalBody.innerHTML = '';
        const playIcon = `<svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>`;
        const pauseIcon = `<svg class="pause-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>`;
        const dlIcon = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>`;

        tracks.forEach((track, i) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'track-list-item';
            itemEl.dataset.trackId = track.id;
            itemEl.innerHTML = `<div class="track-info-row"><span>${i + 1}. ${track.title}</span><div class="track-actions"><button class="play-btn">${playIcon}${pauseIcon}</button><button class="dl-btn">${dlIcon}</button></div></div>`;
            itemEl.querySelector('.play-btn').addEventListener('click', () => {
                if (player.currentTrack && player.currentTrack.id === track.id) player.togglePlayPause();
                else {
                    player.tracklist = tracks;
                    player.playTrackAtIndex(i, albumItem.id);
                }
            });
            itemEl.querySelector('.dl-btn').addEventListener('click', e => triggerDirectDownload(track));
            dom.tracklistModalBody.appendChild(itemEl);
        });
        updateTrackListUI();
    } catch (err) { dom.tracklistModalBody.innerHTML = `<p>加载曲目失败: ${err.message}</p>`; }
}

export async function showArtistModal(artistId) {
    dom.artistModal.classList.add('is-visible');
    document.body.classList.add('modal-open');
    dom.artistModalBody.innerHTML = '<p>正在加载...</p>';
    dom.artistModalTitle.textContent = "歌手详情";
    dom.artistModalAvatar.src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
    try {
        const { details, albums, singles } = await getArtistDetailsAPI(artistId);
        dom.artistModalTitle.textContent = details.name;
        const picId = details.picture?.replace(/-/g, '/');
        dom.artistModalAvatar.src = picId ? `https://resources.tidal.com/images/${picId}/160x160.jpg` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        dom.artistModalBody.innerHTML = '';
        
        const createSection = (title, items) => {
            if (items && items.length > 0) {
                const titleEl = document.createElement('h4');
                titleEl.className = 'artist-section-title';
                titleEl.textContent = title;
                dom.artistModalBody.appendChild(titleEl);

                const wall = document.createElement('div');
                wall.className = 'cover-wall';
                items.forEach((item, index) => wall.appendChild(createCard(item, items, 'album', index)));
                dom.artistModalBody.appendChild(wall);
            }
        };
        createSection('专辑', albums);
        createSection('EP & 单曲', singles);
        updatePlayerUI();
    } catch (err) {
        dom.artistModalBody.innerHTML = `<p>加载歌手详情失败: ${err.message}</p>`;
    }
}

export async function startAlbumPlayback(albumId) { 
    try { 
        const { tracks } = await getAlbumTracksAPI(albumId);
        if (tracks?.length) { 
            player.tracklist = tracks; 
            player.playTrackAtIndex(0, albumId); 
        } 
    } catch (err) { alert("播放专辑失败"); } 
}

export function updateDownloadQueueModal() {
    dom.downloadQueueBody.innerHTML = '';
    const cancelIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    
    let allTasks = [];
    
    if (downloadQueue.isProcessing && downloadQueue.currentTask) {
        allTasks.push({ ...downloadQueue.currentTask, isCurrent: true, id: downloadQueue.currentTask.trackId || 'current-album' });
    }
    
    downloadQueue.queue.forEach((task, index) => {
        allTasks.push({ ...task, isCurrent: false, id: task.trackId || `queued-${index}`, queueIndex: index });
    });

    if (allTasks.length === 0) {
        dom.downloadQueueBody.innerHTML = '<p>队列为空</p>';
        return;
    }

    allTasks.forEach((task) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'queue-item';
        itemEl.dataset.taskId = task.id;
        if (task.isCurrent) {
            itemEl.classList.add('is-processing');
        }

        itemEl.innerHTML = `
            <div class="queue-item-header">
                <span class="queue-item-title">${task.isCurrent ? '[正在处理]' : '[等待中]'} ${task.name}</span>
                <button class="queue-item-cancel-btn" title="取消任务">${cancelIcon}</button>
            </div>
            ${task.isCurrent ? `
            <div class="queue-item-progress-container">
                <div class="queue-item-progress-bar" style="width: ${dom.downloadProgressBar.style.width || '0%'}"></div>
            </div>
            ` : ''}
        `;
        
        itemEl.querySelector('.queue-item-cancel-btn').addEventListener('click', () => {
            if (task.isCurrent) {
                downloadQueue.cancelCurrent();
            } else {
                downloadQueue.cancelTask(task.queueIndex);
            }
        });

        dom.downloadQueueBody.appendChild(itemEl);
    });
}

export function updateDownloadManagerStatus({ albumTitle, trackStatus, autoHide = false }) {
    dom.downloadManager.classList.add('visible');
    if (albumTitle !== undefined) dom.downloadAlbumTitle.textContent = albumTitle;
    if (trackStatus !== undefined) dom.downloadTrackStatus.textContent = trackStatus;

    if (autoHide) {
        setTimeout(() => {
            const queueCountElement = dom.downloadQueueCount;
            const hasQueue = queueCountElement && !queueCountElement.classList.contains('hidden') && parseInt(queueCountElement.textContent, 10) > 0;
            if (!hasQueue) dom.downloadManager.classList.remove('visible');
        }, 1500);
    }
}

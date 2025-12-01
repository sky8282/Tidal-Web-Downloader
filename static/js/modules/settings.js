// js/modules/settings.js

export const settingsManager = {
    defaults: {
        downloadHires: false,
        hiresThreads: 5,
        diskCache: true,
        folderFormat: '{artist}/{album} ({year})',
        filenameFormat: '{trackNumber}. {title}',
        metadataFields: {
            title: true, artist: true, album_artist: true, album: true,
            track: true, disc: true, date: true, copyright: true, isrc: true,
            lyrics: true,
        }
    },
    config: {},
    init() {
        this.load();
        this.populateMetadataCheckboxes();
        this.applyToUI();
        this.save();
        document.getElementById('setting-download-hires').addEventListener('change', (e) => {
            this.toggleHiresThreadsVisibility(e.target.checked);
        });
    },
    load() {
        try {
            const storedConfig = localStorage.getItem('tidalDLSettings');
            let loadedConfig = storedConfig ? JSON.parse(storedConfig) : {};
            this.config = { ...this.defaults, ...loadedConfig };
            this.config.metadataFields = { ...this.defaults.metadataFields, ...(loadedConfig.metadataFields || {}) };

        } catch (e) {
            console.error("加载设置失败，将使用默认设置。", e);
            this.config = JSON.parse(JSON.stringify(this.defaults));
        }
    },
    save() {
        try {
            localStorage.setItem('tidalDLSettings', JSON.stringify(this.config));
        } catch (e) {
            console.error("保存设置失败。", e);
        }
    },
    restoreDefaults() {
        this.config = JSON.parse(JSON.stringify(this.defaults));
        this.applyToUI();
        this.save();
    },
    applyToUI() {
        document.getElementById('setting-download-hires').checked = this.config.downloadHires;
        document.getElementById('setting-hires-threads').value = this.config.hiresThreads;
        document.getElementById('setting-disk-cache').checked = this.config.diskCache; // ‼️ NEW
        document.getElementById('setting-folder-format').value = this.config.folderFormat;
        document.getElementById('setting-filename-format').value = this.config.filenameFormat;

        for (const key in this.config.metadataFields) {
            const checkbox = document.getElementById(`metadata-${key}`);
            if (checkbox) {
                checkbox.checked = this.config.metadataFields[key];
            }
        }
        this.toggleHiresThreadsVisibility(this.config.downloadHires);
    },
    updateFromUI() {
        this.config.downloadHires = document.getElementById('setting-download-hires').checked;
        this.config.hiresThreads = parseInt(document.getElementById('setting-hires-threads').value, 10) || 5;
        this.config.diskCache = document.getElementById('setting-disk-cache').checked; // ‼️ NEW
        this.config.folderFormat = document.getElementById('setting-folder-format').value;
        this.config.filenameFormat = document.getElementById('setting-filename-format').value;
        for (const key in this.config.metadataFields) {
            const checkbox = document.getElementById(`metadata-${key}`);
            if (checkbox) {
                this.config.metadataFields[key] = checkbox.checked;
            }
        }
        this.save();
    },
    toggleHiresThreadsVisibility(isHiresEnabled) {
        const container = document.getElementById('setting-hires-threads-container');
        if (container) {
            container.style.display = isHiresEnabled ? '' : 'none';
        }
    },
    populateMetadataCheckboxes() {
        const container = document.getElementById('metadata-settings-container');
        container.innerHTML = '';
        const labels = {
            title: '曲目名', artist: '艺人', album_artist: '专辑艺人', album: '专辑名',
            track: '音轨号', disc: '碟片号', date: '发行日期', copyright: '版权信息', isrc: 'ISRC',
            lyrics: '歌词'
        };
        for (const key in this.defaults.metadataFields) {
            const div = document.createElement('div');
            div.className = 'checkbox-item';
            const checkboxId = `metadata-${key}`;
            div.innerHTML = `
                <input type="checkbox" id="${checkboxId}" name="${key}">
                <label for="${checkboxId}">${labels[key] || key}</label>
            `;
            container.appendChild(div);
        }
    }
};
// js/modules/utils.js

export function copyTextToClipboard(text, buttonElement) {
    navigator.clipboard.writeText(text).then(() => {
        const originalHTML = buttonElement.innerHTML;
        buttonElement.innerHTML = `<svg viewBox="0 0 24 24" style="width: 22px; height: 22px; fill: var(--primary-color);"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"></path></svg>`;
        setTimeout(() => { buttonElement.innerHTML = originalHTML; }, 1000);
    }).catch(err => { console.error('复制失败:', err); });
}
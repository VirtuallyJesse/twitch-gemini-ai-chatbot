// public/js/views/gallery_view.js
// Autonomous GalleryView module managing media cards, type filtering, client pagination, and user auth drawer.

import { escapeHtml } from '../utils/web_emotes.js';

export class GalleryView {
    constructor() {
        this.id = 'gallery';
        this._container = null;
        this._context = null;
        this._unsubscribers = [];

        this.mediaFilter = 'all';
        this.mediaPage = 1;
        this.mediaPerPage = 12;

        this._galleryEl = null;
        this._paginationEl = null;
        this._userChipBtn = null;
        this._userDrawer = null;
        this._openConfigBtn = null;
        this._filtersContainer = null;
        this._observer = null;

        this._handleDocClick = this._handleDocClick.bind(this);
    }

    /**
     * @param {HTMLElement} container
     * @param {Object} context
     * @param {import('../runtime/dashboard_runtime.js').DashboardRuntime} context.runtime
     * @param {import('../runtime/api_client.js').ApiClient} context.apiClient
     * @param {Function} [context.onOpenConfig]
     */
    mount(container, context) {
        this._container = container;
        this._context = context;

        const doc = container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
        this._galleryEl = container.querySelector('#media-gallery') || doc?.getElementById?.('media-gallery');
        this._paginationEl = container.querySelector('#pagination-controls') || doc?.getElementById?.('pagination-controls');
        this._userChipBtn = container.querySelector('#user-chip-btn') || doc?.getElementById?.('user-chip-btn');
        this._userDrawer = container.querySelector('#user-drawer') || doc?.getElementById?.('user-drawer');
        this._openConfigBtn = container.querySelector('#open-config-btn') || doc?.getElementById?.('open-config-btn');
        this._filtersContainer = container.querySelector('#media-filters') || container.querySelector('.filters');

        this._setupFilters();
        this._setupUserDrawer();

        // Subscribe to runtime events
        const { runtime } = context;
        this._unsubscribers.push(
            runtime.on('media:loaded', () => {
                this.render();
            }),
            runtime.on('media:new', (item) => {
                this._onNewMedia(item);
            })
        );

        this.render();
    }

    _setupFilters() {
        if (!this._filtersContainer) return;
        this._filtersContainer.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.dataset.filter || btn.textContent.toLowerCase().trim().replace(/s$/, '');
                const type = filter.includes('image') ? 'image'
                    : filter.includes('video') ? 'video'
                    : filter.includes('audio') ? 'audio'
                    : 'all';
                this.setFilter(type);
            });
        });
    }

    _setupUserDrawer() {
        if (this._userChipBtn && this._userDrawer) {
            this._userChipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = this._userDrawer.style.display !== 'none';
                this._userDrawer.style.display = isOpen ? 'none' : 'flex';
                this._userChipBtn.setAttribute('aria-expanded', String(!isOpen));
            });

            const doc = this._container?.ownerDocument || document;
            doc.addEventListener('click', this._handleDocClick);
        }

        if (this._openConfigBtn) {
            this._openConfigBtn.addEventListener('click', () => {
                if (this._userDrawer) this._userDrawer.style.display = 'none';
                if (this._userChipBtn) this._userChipBtn.setAttribute('aria-expanded', 'false');
                if (this._context?.onOpenConfig) {
                    this._context.onOpenConfig();
                }
            });
        }
    }

    _handleDocClick(e) {
        if (this._userDrawer && this._userChipBtn) {
            if (!this._userDrawer.contains(e.target) && e.target !== this._userChipBtn && !this._userChipBtn.contains(e.target)) {
                this._userDrawer.style.display = 'none';
                this._userChipBtn.setAttribute('aria-expanded', 'false');
            }
        }
    }

    setFilter(type) {
        this.mediaFilter = type;
        this.mediaPage = 1;

        if (this._filtersContainer) {
            this._filtersContainer.querySelectorAll('.filter-btn').forEach(btn => {
                const btnType = btn.dataset.filter || btn.textContent.toLowerCase().trim().replace(/s$/, '');
                const norm = btnType.includes('image') ? 'image' : btnType.includes('video') ? 'video' : btnType.includes('audio') ? 'audio' : 'all';
                btn.classList.toggle('active', norm === type);
            });
        }

        this.render();
    }

    goToPage(page) {
        this.mediaPage = page;
        this.render();
        if (this._galleryEl) {
            this._galleryEl.scrollTop = 0;
        }
    }

    _onNewMedia(item) {
        if (this.mediaFilter === 'all' ||
            this.mediaFilter === item.mediaType ||
            (this.mediaFilter === 'audio' && ['audio', 'music', 'tts'].includes(item.mediaType))) {
            this.render();
        }
    }

    render() {
        if (!this._galleryEl || !this._context) return;
        const { runtime } = this._context;

        const mediaData = runtime.mediaData || [];
        const filtered = this.mediaFilter === 'all'
            ? mediaData
            : mediaData.filter(m => {
                if (this.mediaFilter === 'audio') {
                    return ['audio', 'music', 'tts'].includes(m.mediaType);
                }
                return m.mediaType === this.mediaFilter;
            });

        const totalPages = Math.max(1, Math.ceil(filtered.length / this.mediaPerPage));
        if (this.mediaPage > totalPages) this.mediaPage = totalPages;
        if (this.mediaPage < 1) this.mediaPage = 1;

        const start = (this.mediaPage - 1) * this.mediaPerPage;
        const pageItems = filtered.slice(start, start + this.mediaPerPage);

        this._galleryEl.innerHTML = pageItems.map(item => this.createMediaCard(item)).join('');
        this.renderPagination(totalPages, filtered.length);
        this.observeImages();
    }

    createMediaCard(item) {
        const date = new Date(item.timestamp);
        const timeStr = isNaN(date.getTime()) ? '' : date.toLocaleString();

        let mediaContent = '';
        if (item.mediaType === 'image') {
            mediaContent = `<img data-src="${escapeHtml(item.mediaUrl)}" class="lazy-media" alt="Generated Image" onclick="window.open('${escapeHtml(item.mediaUrl)}', '_blank')">`;
        } else if (item.mediaType === 'video') {
            mediaContent = `
                <video controls preload="none" poster="">
                    <source src="${escapeHtml(item.mediaUrl)}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>`;
        } else if (item.mediaType === 'audio' || item.mediaType === 'music' || item.mediaType === 'tts') {
            mediaContent = `
                <div class="audio-player">
                    <div class="audio-icon">🎵</div>
                    <audio controls preload="none">
                        <source src="${escapeHtml(item.mediaUrl)}" type="audio/mpeg">
                    </audio>
                </div>`;
        }

        return `
            <div class="media-card">
                <div class="media-content">
                    ${mediaContent}
                </div>
                <div class="media-info">
                    <div class="prompt" title="${escapeHtml(item.prompt || '')}">"${escapeHtml(item.prompt || '')}"</div>
                    <div class="meta" title="${escapeHtml(item.command || '')} by ${escapeHtml(item.username || '')} - ${timeStr}">
                        <span class="cmd">${escapeHtml(item.command || '')}</span>
                        <span class="by">by ${escapeHtml(item.username || '')}</span>
                        <span class="at">${timeStr}</span>
                    </div>
                </div>
            </div>
        `;
    }

    renderPagination(totalPages, totalItems) {
        if (!this._paginationEl) return;
        if (totalPages <= 1) {
            this._paginationEl.innerHTML = `<span class="page-info">${totalItems} item${totalItems !== 1 ? 's' : ''}</span>`;
            return;
        }

        let html = '';
        html += `<button class="page-btn page-first" ${this.mediaPage === 1 ? 'disabled' : ''}>&laquo;</button>`;
        html += `<button class="page-btn page-prev" ${this.mediaPage === 1 ? 'disabled' : ''}>&lsaquo;</button>`;

        const maxVisible = 5;
        let startPage = Math.max(1, this.mediaPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage + 1 < maxVisible) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<button class="page-btn page-num ${i === this.mediaPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        }

        html += `<button class="page-btn page-next" ${this.mediaPage === totalPages ? 'disabled' : ''}>&rsaquo;</button>`;
        html += `<button class="page-btn page-last" ${this.mediaPage === totalPages ? 'disabled' : ''}>&raquo;</button>`;
        html += `<span class="page-info">Page ${this.mediaPage} of ${totalPages} (${totalItems} items)</span>`;

        this._paginationEl.innerHTML = html;

        // Attach pagination click handlers
        this._paginationEl.querySelector('.page-first')?.addEventListener('click', () => this.goToPage(1));
        this._paginationEl.querySelector('.page-prev')?.addEventListener('click', () => this.goToPage(this.mediaPage - 1));
        this._paginationEl.querySelector('.page-next')?.addEventListener('click', () => this.goToPage(this.mediaPage + 1));
        this._paginationEl.querySelector('.page-last')?.addEventListener('click', () => this.goToPage(totalPages));
        this._paginationEl.querySelectorAll('.page-num').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (!isNaN(p)) this.goToPage(p);
            });
        });
    }

    observeImages() {
        if (typeof IntersectionObserver === 'undefined' || !this._galleryEl) {
            // Fallback if IntersectionObserver is unavailable (e.g. mock DOM environment)
            this._galleryEl?.querySelectorAll('img.lazy-media').forEach(img => {
                if (img.dataset.src) {
                    img.src = img.dataset.src;
                    img.classList.remove('lazy-media');
                }
            });
            return;
        }

        if (this._observer) {
            this._observer.disconnect();
        }

        this._observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.dataset.src;
                    img.classList.remove('lazy-media');
                    obs.unobserve(img);
                }
            });
        });

        this._galleryEl.querySelectorAll('.lazy-media').forEach(img => this._observer.observe(img));
    }

    unmount() {
        const doc = this._container?.ownerDocument || document;
        doc.removeEventListener('click', this._handleDocClick);

        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }

        this._unsubscribers.forEach(unsub => unsub());
        this._unsubscribers = [];
        this._container = null;
        this._context = null;
        this._galleryEl = null;
        this._paginationEl = null;
        this._userChipBtn = null;
        this._userDrawer = null;
        this._openConfigBtn = null;
        this._filtersContainer = null;
    }
}

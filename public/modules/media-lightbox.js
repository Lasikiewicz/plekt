import { escapeAttribute, isDemoMode } from "./utils.js?v=2.0.0.0.10";

export function initMediaLightbox() {
  // Side-effect globals below preserve existing inline/event-delegated handlers.
}

window.playTrailer = function (el, videoKey, videoName) {
  const container = el.closest('.trailer-scroll-row');
  if (container) {
    container.querySelectorAll('.trailer-thumb-container').forEach(thumbCont => {
      if (thumbCont !== el && thumbCont.querySelector('iframe')) {
        const key = thumbCont.dataset.videoKey;
        const name = thumbCont.dataset.videoName;
        const thumbnail = thumbCont.dataset.videoThumbnail || (isDemoMode() ? "/favicon.svg" : `https://img.youtube.com/vi/${key}/mqdefault.jpg`);
        thumbCont.innerHTML = `
          <img class="trailer-thumb" src="${escapeAttribute(thumbnail)}" alt="${escapeAttribute(name)}" data-err="fav" />
          <div class="play-overlay">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
        `;
      }
    });
  }
  el.style.overflow = "visible";
  const embedUrl = new URL(`https://www.youtube.com/embed/${encodeURIComponent(String(videoKey || ""))}`);
  embedUrl.searchParams.set("autoplay", "1");
  embedUrl.searchParams.set("origin", window.location.origin);
  embedUrl.searchParams.set("widget_referrer", window.location.href);
  el.innerHTML = `<iframe src="${escapeAttribute(embedUrl.toString())}" frameborder="0" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;"></iframe>`;
};

// Photo lightbox
(function () {
  let photos = [];
  let current = 0;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let lb = null;
  // drag state
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panAtDragX = 0;
  let panAtDragY = 0;

  function showPrevious() {
    current = (current - 1 + photos.length) % photos.length;
    render();
  }

  function showNext() {
    current = (current + 1) % photos.length;
    render();
  }

  function changeZoom(delta) {
    if (delta === 0) {
      scale = 1;
      panX = 0;
      panY = 0;
    } else if (delta > 0) {
      scale = Math.min(scale + 0.5, 5);
    } else {
      scale = Math.max(scale - 0.5, 0.5);
      if (scale === 1) {
        panX = 0;
        panY = 0;
      }
    }
    applyTransform();
  }

  function visibleImageRect(img, wrap) {
    const wrapRect = wrap.getBoundingClientRect();
    if (!img.naturalWidth || !img.naturalHeight) return wrapRect;
    const imageRatio = img.naturalWidth / img.naturalHeight;
    const wrapRatio = wrapRect.width / wrapRect.height;
    let width;
    let height;

    if (wrapRatio > imageRatio) {
      height = wrapRect.height;
      width = height * imageRatio;
    } else {
      width = wrapRect.width;
      height = width / imageRatio;
    }

    return {
      left: wrapRect.left + ((wrapRect.width - width) / 2),
      right: wrapRect.left + ((wrapRect.width + width) / 2),
      top: wrapRect.top + ((wrapRect.height - height) / 2),
      bottom: wrapRect.top + ((wrapRect.height + height) / 2),
    };
  }

  function applyTransform() {
    const img = lb.querySelector('.photo-lightbox-img');
    const wrap = lb.querySelector('.photo-lightbox-img-wrap');
    lb.classList.toggle('photo-lightbox--zoomed', scale !== 1);
    if (scale === 1) {
      img.style.transform = '';
      wrap.classList.remove('grabbing');
      wrap.style.cursor = '';
    } else {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      wrap.style.cursor = dragging ? 'grabbing' : 'grab';
    }
  }

  function render() {
    const img = lb.querySelector('.photo-lightbox-img');
    img.src = photos[current];
    scale = 1; panX = 0; panY = 0;
    applyTransform();
    lb.querySelector('.photo-lightbox-counter').textContent = `${current + 1} / ${photos.length}`;
    lb.querySelector('.photo-lightbox-nav--prev').style.display = photos.length > 1 ? '' : 'none';
    lb.querySelector('.photo-lightbox-nav--next').style.display = photos.length > 1 ? '' : 'none';
  }

  function open(srcs, index) {
    photos = srcs;
    current = index;
    if (!lb) {
      lb = document.createElement('div');
      lb.className = 'photo-lightbox';
      lb.setAttribute('role', 'dialog');
      lb.setAttribute('aria-modal', 'true');
      lb.setAttribute('aria-label', 'Image viewer');
      lb.innerHTML = `
        <div class="photo-lightbox-img-wrap">
          <img class="photo-lightbox-img" alt="" draggable="false" />
          <button class="photo-lightbox-nav photo-lightbox-nav--prev" type="button" aria-label="Previous image" title="Previous image">&#8249;</button>
          <button class="photo-lightbox-nav photo-lightbox-nav--next" type="button" aria-label="Next image" title="Next image">&#8250;</button>
        </div>
        <div class="photo-lightbox-controls" aria-label="Image controls">
          <button class="photo-lightbox-btn" type="button" data-lb-zoom="-1" aria-label="Zoom out" title="Zoom out">-</button>
          <button class="photo-lightbox-btn" type="button" data-lb-zoom="0" aria-label="Reset zoom" title="Reset zoom">1:1</button>
          <button class="photo-lightbox-btn" type="button" data-lb-zoom="1" aria-label="Zoom in" title="Zoom in">+</button>
          <span class="photo-lightbox-counter" aria-live="polite"></span>
          <button class="photo-lightbox-btn" type="button" data-lb-close aria-label="Close image viewer" title="Close">x</button>
        </div>
      `;

      // Zoom buttons + close
      lb.addEventListener('click', (e) => {
        if (dragging) return;
        if (e.target.dataset.lbClose !== undefined || e.target === lb) { close(); return; }
        const z = e.target.dataset.lbZoom;
        if (z === undefined) return;
        changeZoom(Number(z));
      });

      // Wheel zoom
      const wrap = lb.querySelector('.photo-lightbox-img-wrap');
      wrap.addEventListener('click', (e) => {
        if (dragging || scale > 1 || e.target.closest('button')) return;
        const img = lb.querySelector('.photo-lightbox-img');
        const rect = visibleImageRect(img, wrap);
        const isInsideImage = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (!isInsideImage) {
          close();
          return;
        }
        if (photos.length <= 1) return;
        if (e.clientX < rect.left + ((rect.right - rect.left) / 2)) {
          showPrevious();
        } else {
          showNext();
        }
      });

      wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.min(5, Math.max(0.5, scale - e.deltaY * 0.001));
        if (scale === 1) { panX = 0; panY = 0; }
        applyTransform();
      }, { passive: false });

      // Drag to pan
      wrap.addEventListener('mousedown', (e) => {
        if (scale <= 1) return;
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panAtDragX = panX;
        panAtDragY = panY;
        wrap.classList.add('grabbing');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panX = panAtDragX + (e.clientX - dragStartX);
        panY = panAtDragY + (e.clientY - dragStartY);
        applyTransform();
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove('grabbing');
        applyTransform();
      });

      // Nav arrows
      lb.querySelector('.photo-lightbox-nav--prev').addEventListener('click', (e) => {
        e.stopPropagation();
        showPrevious();
      });
      lb.querySelector('.photo-lightbox-nav--next').addEventListener('click', (e) => {
        e.stopPropagation();
        showNext();
      });

      document.body.appendChild(lb);
    }
    lb.style.display = 'flex';
    render();
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (lb) lb.style.display = 'none';
    dragging = false;
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => {
    if (!lb || lb.style.display === 'none') return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') showPrevious();
    if (e.key === 'ArrowRight') showNext();
  });

  window.openPhotoLightbox = function (srcs, index) { open(srcs, index); };
})();

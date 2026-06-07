// Shared image helpers: read a File to a data URL and downscale it.
export function readFile(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(file);
  });
}

export function downscale(dataUrl, max) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      try { res(c.toDataURL('image/png')); } catch (_) { res(dataUrl); }
    };
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}

/**
 * The hands-free phone's photo prep (dashboard lib/phonePhoto.ts, task hands-free-phone-shows-
 * every-picture…, D4): the long edge never exceeds 2560 px and is never enlarged; a prepared
 * photo is sent as a .jpg; a photo the browser cannot decode is never sent. The canvas half is
 * exercised in a real browser by scripts/verify/handsfree-phone-photo.mjs.
 */
import { describe, it, expect } from 'vitest';
import { PHONE_PHOTOS_PER_MESSAGE, fitWithin, jpegName, preparePhonePhoto } from '../../dashboard/src/lib/phonePhoto.js';

describe('fitWithin', () => {
  it('scales a 48 MP portrait photo down to a 2560 px long edge, keeping its shape', () => {
    expect(fitWithin(6048, 8064)).toEqual({ w: 1920, h: 2560 });
  });

  it('scales a landscape photo on its width', () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: 2560, h: 1920 });
  });

  it('never enlarges a small picture', () => {
    expect(fitWithin(1170, 2532)).toEqual({ w: 1170, h: 2532 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
  });

  it('answers nothing drawable for a broken size', () => {
    expect(fitWithin(0, 100)).toEqual({ w: 0, h: 0 });
    expect(fitWithin(Number.NaN, 100)).toEqual({ w: 0, h: 0 });
  });
});

describe('jpegName', () => {
  it('sends a HEIC, PNG or nameless photo as a .jpg', () => {
    expect(jpegName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(jpegName('screen.png')).toBe('screen.jpg');
    expect(jpegName('')).toBe('photo.jpg');
  });
});

describe('preparePhonePhoto', () => {
  it('resolves null when nothing can decode the photo (it is then never sent)', async () => {
    expect(await preparePhonePhoto(new Blob([Buffer.from('not an image')]))).toBeNull();
  });

  it('keeps six photos to a message', () => {
    expect(PHONE_PHOTOS_PER_MESSAGE).toBe(6);
  });
});

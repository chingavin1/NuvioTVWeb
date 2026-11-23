import test from "node:test";
import assert from "node:assert/strict";
import { createPlayerScreenMethods28 } from "./playerScreenMethods-28-unbind-video-events.js";

const methods = createPlayerScreenMethods28();

function withDoc(doc, fn) {
  const prev = globalThis.document;
  globalThis.document = doc;
  try {
    return fn();
  } finally {
    globalThis.document = prev;
  }
}

test("PiP is offered only on the touch tier with a PiP-capable document", () => {
  const video = { id: "videoPlayer", requestPictureInPicture: () => Promise.resolve() };
  const touchDoc = {
    pictureInPictureEnabled: true,
    body: { classList: { contains: (name) => name === "web-touch" } },
    getElementById: (id) => (id === "videoPlayer" ? video : null)
  };
  const self = { ...methods, isExternalFrameMode: () => false };
  assert.equal(
    withDoc(touchDoc, () => self.isPictureInPictureAvailable()),
    true
  );
  // TV tier keeps its own background behavior.
  assert.equal(
    withDoc({ ...touchDoc, body: { classList: { contains: () => false } } }, () =>
      self.isPictureInPictureAvailable()
    ),
    false
  );
  // webOS AVPlay / old WebKit documents report no PiP support.
  assert.equal(
    withDoc({ ...touchDoc, pictureInPictureEnabled: false }, () =>
      self.isPictureInPictureAvailable()
    ),
    false
  );
  // No persistent shell video (external-frame trailers).
  assert.equal(
    withDoc({ ...touchDoc, getElementById: () => null }, () => self.isPictureInPictureAvailable()),
    false
  );
  assert.equal(
    withDoc(touchDoc, () =>
      ({ ...self, isExternalFrameMode: () => true }).isPictureInPictureAvailable()
    ),
    false
  );
});

test("togglePictureInPicture requests PiP or exits when already presenting", () => {
  let requests = 0;
  let exits = 0;
  const video = {
    id: "videoPlayer",
    requestPictureInPicture: () => {
      requests += 1;
      return Promise.resolve();
    }
  };
  const doc = {
    pictureInPictureEnabled: true,
    body: { classList: { contains: () => true } },
    getElementById: () => video,
    pictureInPictureElement: null,
    exitPictureInPicture: () => {
      exits += 1;
      return Promise.resolve();
    }
  };
  const self = { ...methods, isExternalFrameMode: () => false };
  withDoc(doc, () => self.togglePictureInPicture());
  assert.equal(requests, 1);
  doc.pictureInPictureElement = video;
  withDoc(doc, () => self.togglePictureInPicture());
  assert.equal(exits, 1);
  assert.equal(requests, 1);
  // Rejected requests (autoplay policy, unsupported source) stay silent.
  doc.pictureInPictureElement = null;
  video.requestPictureInPicture = () => Promise.reject(new Error("denied"));
  withDoc(doc, () => self.togglePictureInPicture());
});

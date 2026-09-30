'use strict';

function isBrowserChromeAudioRequest(browserContents, requestingContents, permission, details = {}) {
  return !!browserContents && requestingContents === browserContents && permission === 'media' &&
    Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}

function isBrowserChromeAudioCheck(browserContents, requestingContents, permission, details = {}) {
  return !!browserContents && requestingContents === browserContents && permission === 'media' &&
    details.mediaType === 'audio' && details.isMainFrame !== false;
}

function configureMediaPermissions(electronSession, getBrowserContents) {
  electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isBrowserChromeAudioRequest(getBrowserContents(), contents, permission, details));
  });
  electronSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    isBrowserChromeAudioCheck(getBrowserContents(), contents, permission, details));
}

module.exports = { isBrowserChromeAudioRequest, isBrowserChromeAudioCheck, configureMediaPermissions };

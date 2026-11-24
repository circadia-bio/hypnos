// The one place the version is set. app.js fills every [data-version] and [data-stage]
// element on the page from these, so a new release is a one-line change here.
// (index.html carries the same text as a placeholder until the script runs.)

export const VERSION = '0.1.0';
export const STAGE = 'beta';          // 'beta' while the markers are unvalidated; '' for a full release

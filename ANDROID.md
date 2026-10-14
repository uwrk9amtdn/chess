# Android app

The Android app is a Trusted Web Activity: a small app that opens the hosted
site full-screen in Chrome. It has no copy of the site, so whatever is deployed
is what the app shows; a new APK is only needed to change the app's icon, name
or package.

The site is ready for it: `public/manifest.webmanifest`, the icons in
`public/icons/` and the service worker `public/sw.js`, which shows
`public/offline.html` when there is no connection.

## One-time setup

Nothing needs installing: the commands below run Bubblewrap with `npx`, which
fetches it into npm's cache in your home folder the first time (it asks to
confirm). On its first run Bubblewrap offers to download JDK 17 and the
Android SDK (1–2 GB) into `~/.bubblewrap`. Let it.

## Building the APK

Deploy the site first, then, in this folder:

```sh
mkdir android && cd android
npx @bubblewrap/cli init --manifest https://<your-domain>/manifest.webmanifest
npx @bubblewrap/cli build
```

`init` asks for a package id (such as `com.yourname.gameroom`) and creates a
signing key, `android.keystore`. **Back up the key and its password.** Every
later version of the app must be signed with the same key, or phones refuse to
install it over the old one. `android/` and keystores are ignored by git.

`build` writes `app-release-signed.apk`, the file to share.

## Hiding the address bar

Until the site proves it belongs to the app, the app shows a thin address bar
at the top. To remove it:

```sh
npx @bubblewrap/cli fingerprint generateAssetLinks
```

Copy the resulting `assetlinks.json` to `public/.well-known/assetlinks.json`,
commit it and deploy. The app picks it up the next time it starts.

## Installing

Send the APK to the phone and open it. Android asks to allow installing
unknown apps from the browser or file manager it was opened in; Play Protect
may warn about an app it does not know, which is usual for an APK that is not
from the Play Store.

To release a new version, raise `appVersionCode` in `android/twa-manifest.json`,
run `npx @bubblewrap/cli update` and `npx @bubblewrap/cli build` again.

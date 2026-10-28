# Skyline Android preview

This first APK target is a lightweight Android shell that opens the existing Skyline web client at `https://pisosisosisosisosi.github.io/oursocial-network/`. It reuses the same web account/backend rather than introducing a separate account store.

This is a preview bridge, not yet the full native Telegram-style Android client. It requires internet access and a working deployed web client/API. The app does not connect to Telegram production services.

The GitHub Actions workflow `Build Skyline Android preview APK` generates the Android project with Capacitor, builds a debug APK, and uploads it as an Actions artifact. The APK is for testing only; it is not a signed production release.

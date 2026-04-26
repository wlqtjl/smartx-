# 3D Models (runtime, optional)

This directory is loaded by `AssetLoader` (see `client/src/engine/AssetLoader.ts` and
`client/src/engine/AssetManifest.ts`) at runtime. **Binary GLB files are not
checked in** to keep the repository small and CI fast.

The application works without these files — `AssetLoader` falls back to
placeholder geometry, identical to the pre-asset experience.

To enable the full visual upgrade, see [`CREDITS.md`](./CREDITS.md) for the list
of recommended CC0 / CC-BY sources and the expected file layout.

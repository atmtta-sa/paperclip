# Agent Office upstream provenance

The Agent Office plugin incorporates the visual renderer from:

- Repository: <https://github.com/masakav3/Agent-Office-Dashboard.git>
- Revision: `ca3e5fc64ceb8092983bf8eb509afff57b3f085e`
- Upstream code license: MIT, Copyright © 2026 MATYPE
- Renderer source: `frontend/office3d.js`
- Renderer: Three.js r160, MIT
- 3D assets: Kenney low-poly furniture, characters, and vegetation, CC0 1.0

The upstream MIT notice must remain with copied or adapted renderer code. Kenney kit license files must remain with any imported assets.

## Integration boundary

Only the 3D renderer and assets required by the selected single-level Office layout may be incorporated. The following upstream components are intentionally excluded:

- Flask backend;
- `cc-rooms.json` file state;
- `/cc/push`, `/cc/rooms`, `/cc/weather`, and geocoding control paths;
- agent hook installers;
- Phaser/legacy 2D renderer;
- provider or worker mutation behavior.

Paperclip remains authoritative for companies, agents, tasks, runs, approvals, and operational state. The Office is a read-only projection.

## Imported renderer asset inventory

The plugin packages the bounded renderer set used by this integration: 18 furniture models, 12 character models, the shared Kenney texture, the two applicable Kenney CC0 license files, and the upstream Agent Office MIT license. No upstream backend or operational state is copied.

## Tiny Treats asset library

The separately namespaced `assets/upstream/tiny-treats/` library contains two complete FREE CC0 catalogs supplied for future visual composition. Importing these catalogs does not assign any model to the live office scene.

- **Tiny Treats – Baked Goods 1.0** — 32 GLTF models, matching binary buffers, shared texture, overview image, and original CC0 license. Created and distributed by Isa Lousberg (<https://www.isalousberg.com>).
- **Tiny Treats – Charming Kitchen 1.1** — 118 GLTF models, matching binary buffers, shared texture, original and v1.1 overview images, and original CC0 license. Created and distributed by Isa Lousberg (<https://www.isalousberg.com>).

Each GLTF retains its exact relative `.bin` and `tiny_treats_texture_1.png` dependencies. The build copies the complete bounded library to `dist/ui/assets/tiny-treats/`; scene selection and placement remain separate, presentation-only work.

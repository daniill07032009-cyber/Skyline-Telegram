# Frontend

React + TypeScript + Vite client for the OurSocial messenger.

## Development

Create `.env` from `.env.example`, then run:

```powershell
npm install
npm run dev
```

The client uses the Python API for authentication, profile data, public keys, authenticated Socket.IO presence and direct-message typing indicators. Configure the API and Socket.IO origins with `VITE_API_URL` and `VITE_SOCKET_URL`.

From this directory, `npm run build` runs the TypeScript project build and creates the deployable static app in `dist/`. `npm run lint` runs Oxlint.

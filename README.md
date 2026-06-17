# TrialScope

TrialScope is a local MVP of the Global Clinical Trial Access Monitor described in the Eco Hackers PDF. It includes:

- An Express controller with monitored endpoints: `GET /health`, `GET /config`, `POST /config`, `GET /proxies`, `POST /proxies`.
- A lookup endpoint at `POST /lookup` and `GET /lookup` that evaluates a diagnostic condition across five regional proxy nodes.
- A React web console for eligibility intake, proxy telemetry, regional visibility variance, trial opportunity gaps, and sponsor cohort alerts.

## Run locally

Use `npm.cmd` in PowerShell if script execution blocks `npm`.

```powershell
cd C:\projects\trialscope\backend
npm.cmd run dev
```

```powershell
cd C:\projects\trialscope\frontend
npm.cmd run dev
```

The frontend proxies `/api` requests to `http://localhost:4000`.

## MVP boundary

This build uses in-memory telemetry and a seeded trial catalog so the console works locally without storing patient data or using live residential proxy credentials. The service shape is ready for real registry adapters, PostgreSQL persistence, and approved proxy credentials.

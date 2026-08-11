# Enrich U — Local setup, GitHub & Vercel deployment

Quick steps to push this project to GitHub and have it automatically deploy to Vercel.

1. Initialize git and create a repository on GitHub (if not already):

```bash
git init
git add -A
git commit -m "Initial commit"
# create a repo on GitHub then:
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

2. Configure Vercel project and GitHub Actions secrets:
- In your GitHub repo go to Settings → Secrets → Actions and add:
  - `VERCEL_TOKEN` — a Vercel personal token (from https://vercel.com/account/tokens)
  - `VERCEL_ORG_ID` — your Vercel organization ID
  - `VERCEL_PROJECT_ID` — your Vercel project ID

Alternatively, connect the GitHub repo directly in the Vercel dashboard — Vercel will automatically deploy on pushes.

3. Use the helper script to commit, push and deploy locally (Windows PowerShell):

```powershell
.\scripts\push-deploy.ps1 -message "Your commit message"
```

If you prefer not to install Vercel CLI locally, pushing to `main` will trigger the GitHub Actions workflow which deploys to Vercel.

4. Environment variables
- For local run, create a `.env` with any of the following as needed:
  - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`)
  - `JWT_SECRET`
  - `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`

5. Start locally

```bash
npm install
npm start
# open http://localhost:3000/login.html
```

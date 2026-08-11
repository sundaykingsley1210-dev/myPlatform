param(
  [string]$message = "Auto commit from local script"
)

if (-not (Test-Path ".git")) {
  Write-Host "No git repository found. Initialize with: git init && git remote add origin <your-repo-url>"
  exit 1
}

git add -A
git commit -m "$message" 2>$null
git push origin main

if (Get-Command vercel -ErrorAction SilentlyContinue) {
  Write-Host "Deploying with Vercel CLI..."
  vercel --prod --confirm
} else {
  Write-Host "Vercel CLI not found. Install with: npm i -g vercel or rely on GitHub Actions to deploy."
}

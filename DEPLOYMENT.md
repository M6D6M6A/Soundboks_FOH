# Deployment

## Local demo

Run from this folder:

```powershell
python -m http.server 5179 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:5179/
```

`localhost` / `127.0.0.1` is treated as a secure context by modern browsers, so it is suitable for Web Bluetooth testing. For real devices, use Chrome or Edge.

## GitHub Pages

This project is static and can be served directly from the repository root.

1. Create a private GitHub repository named `Soundboks_FOH`.
2. Push this folder to the repository.
3. In GitHub, go to `Settings -> Pages`.
4. Set source to `GitHub Actions`.
5. Push to `main` or run the workflow manually.

The workflow at `.github/workflows/pages.yml` deploys the static site.

Note: GitHub Pages support for private repositories depends on the GitHub account/organization plan and visibility settings. If private Pages is not available, use Cloudflare Pages, Netlify, or a public GitHub Pages repo.

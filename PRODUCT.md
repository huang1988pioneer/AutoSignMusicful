# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Repository maintainers who operate one or more Musicful accounts and need to renew login state and supervise automated daily sign-ins.

## Product Purpose

Musicful Flow is a desktop companion for the repository's existing Playwright and GitHub Actions automation. It makes account setup, state export, duplicate protection, manual workflow runs, and run-status review accessible without manually assembling terminal commands.

## Operating Context

The app runs beside this repository on Windows, macOS, or Linux. A user completes Musicful and any third-party login challenges manually in a browser; the app never attempts to bypass OTP, CAPTCHA, or authentication protections.

## Capabilities and Constraints

- Accounts use `MUSICFUL_STORAGE_STATE_BASE64_1` through `_33` GitHub secrets.
- The existing Node/Playwright scripts remain the source of truth for browser automation.
- GitHub Actions access requires the authenticated GitHub CLI (`gh`).
- Inferred from the existing repository and the requested reference implementation; account labels remain locally editable.

## Brand Commitments

The user requested an Avalonia tool modelled after AutoSignOiiOii. The resulting product name is Musicful Flow.

## Evidence on Hand

- Existing sign-in automation: `scripts/musicful-signin.mjs`
- Existing duplicate detection: `scripts/check-duplicate-musicful-secrets.mjs`
- Existing workflows: `.github/workflows/musicful-auto-sign.yml`

## Product Principles

- Keep authentication visibly manual and user-controlled.
- Make state ownership and secret destinations unambiguous.
- Surface automation state before asking users to act.
- Preserve the repository scripts rather than duplicating their automation logic.

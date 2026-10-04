# Soly Mail Broker

Public source code only. Secrets are provided as hosting environment variables and are never committed.

Required environment variables:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- BROKER_MASTER_KEY

The broker uses Google OAuth, encrypts refresh tokens into opaque mobile bundles, and proxies Gmail API calls so the Android app never needs a Gmail password.

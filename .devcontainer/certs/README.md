# Extra CA certificates (optional)

Put PEM certificates with the extension `.crt` here when your network uses a TLS-inspecting proxy.
They are added to the system trust store of the sandbox image (`update-ca-certificates`) and to
Node.js (`NODE_EXTRA_CA_CERTS`). Rebuild the container after adding or removing a certificate.

`*.crt` files in this directory are git-ignored. Never commit certificates or keys.

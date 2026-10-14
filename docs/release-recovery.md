# Recovering partial release publication

The first `v0.8.0` publication run published npm successfully, then failed MCP
registration because the validator could not yet see that npm version.
The version tag remains unchanged. Recovery uses the updated workflow on
`main` while checking out the existing release tag.

From the repository, run:

```bash
gh workflow run publish.yml --ref main -f tag=v0.8.0
```

The workflow validates `vN.N.N`, checks the tag against `package.json`, and
runs the usual build and test gates against that tag. The tests also verify
registry metadata alignment.

npm and MCP registration have independent checks. Existing npm versions skip
`npm publish`. The MCP lookup requires a matching server name and version
on HTTP 200; HTTP 404 proceeds to registration, and other failures stop the
run. An existing registration skips MCP download, authentication, and publish.

Missing MCP registrations use GitHub OIDC authentication and up to five
publish attempts, with 15 seconds between failed attempts. The final failure
remains a failed workflow.

Verify each registry separately:

```bash
npm view diagrams-mcp-server@0.8.0 version
curl --fail --silent --show-error 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mohammad-emad-dev%2Fdiagrams-mcp-server/versions/0.8.0'
```

Check the MCP response's `server.name` and `server.version`. A successful npm
publish alone does not establish MCP registration. Inspect failed workflow
steps before retrying; do not move the tag or republish the npm version.

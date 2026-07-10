# Local extension manifests

ADE discovers local extensions from:

```text
~/.ade/extensions/<extension>/ade-extension.json
```

The registry is declarative and performs no network install. Manifests are size-limited and validated, skill paths must stay inside the extension directory, incompatible platforms are marked, and no command executes until the user explicitly adds or runs it.

```json
{
  "manifestVersion": 1,
  "id": "example.review-tools",
  "name": "Review Tools",
  "version": "1.0.0",
  "description": "Terminal agents and review skills",
  "platforms": ["win32", "darwin"],
  "permissions": ["shell", "filesystem:workspace"],
  "agents": [
    {
      "id": "review-agent",
      "name": "Review Agent",
      "command": "review-agent --interactive"
    }
  ],
  "skills": [
    {
      "name": "review",
      "path": "skills/review/SKILL.md"
    }
  ],
  "mcpServers": [
    {
      "id": "review-mcp",
      "name": "Review MCP",
      "command": "node",
      "args": ["server.mjs"]
    }
  ]
}
```

Agent commands can be reviewed and added to the Agent Bar from **Settings → Integrations**. Skill and MCP entries are discovered and shown but are not auto-enabled; permission review, signing, version pinning, and marketplace downloads are the next extension milestone.

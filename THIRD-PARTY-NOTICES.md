# Third-Party Notices

ADE incorporates material from the third-party projects listed below. Each is
provided under its own license, reproduced in full. These notices are provided
for attribution and do not modify the license under which ADE itself is
distributed (see `LICENSE.md`).

---

## Hermes Agent (Nous Research)

The agent memory scaffold in `apps/desktop/src/main/lib/agent-scaffold.ts`
adapts the structure and self-curation guidance of the Hermes agent
(<https://github.com/NousResearch/hermes-agent>): the write-back protocol is
ported from Hermes' memory tool description, the agent identity and skill
templates follow Hermes' authoring standards, and the session-end reflection is
an ADE adaptation of Hermes' post-turn background review.

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## @lobehub/icons-static-svg (LobeHub)

Provider and model logo marks are sourced from `@lobehub/icons-static-svg`
(<https://github.com/lobehub/lobe-icons>).

```
MIT License

Copyright (c) LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Codicons (Microsoft)

The Codicon icon font is distributed as part of the Monaco editor bundled via
`@monaco-editor/react` (<https://github.com/microsoft/vscode-codicons>).

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Context-efficiency design references (not bundled)

ADE's compact context policy and structured handoff format were informed by the
following MIT-licensed projects:

- Ponytail, verified at commit
  `14a0d79548d4de8fc2de95c1b94bb0de63a739d3`
  (<https://github.com/DietrichGebert/ponytail>), for its minimal-change policy,
  mode scoping, and portable thin-adapter design.
- Caveman, verified at commit
  `0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0`
  (<https://github.com/JuliusBrussee/caveman>), for structured concise subagent
  results and the principle that brevity must not weaken safety or exact data.
- pxpipe, verified at commit
  `8d7ba3ee871c3b1053b188d0f68938229748051a`
  (<https://github.com/teamchong/pxpipe>), for counterfactual context metrics,
  recent-turn preservation, exact-identifier safeguards, and explicit break-even
  gates.

No source files, runtime packages, fonts, image atlases, installers, or prompt
hooks from these projects are bundled in ADE 0.4. In particular, ADE does not
enable pxpipe's lossy image transformation or Caveman's external memory
compressor. The links and pinned commits record the design provenance and make
the evaluated behavior reproducible.

---

## Trademarks

All product names, model names, brand names, and logos referenced in this
software are the property of their respective owners. They are used solely for
identification and interoperability purposes and do not imply any affiliation
with or endorsement by their respective owners.

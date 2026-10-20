ARG FACTORY_LANGUAGE_TOOLS_IMAGE=factory-runtime:language-proof
FROM ${FACTORY_LANGUAGE_TOOLS_IMAGE} AS tools
FROM docker.io/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS dependencies
WORKDIR /opt/project-seed
COPY test/fixtures/language-project/package.json test/fixtures/language-project/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
FROM docker.io/library/python:3.14.3-slim-bookworm@sha256:f21c0d5a44c56805654c15abccc1b2fd576c8d93aca0a3f74b4aba2dc92510e2
COPY --from=tools /usr/local/bin/factory-runtime-connector /usr/local/bin/factory-runtime-connector
COPY --from=tools /opt/factory/language-tools/node_modules /opt/factory/language-tools/node_modules
COPY --from=tools /opt/factory/language-tools/glibc /opt/factory/language-tools/runtime
COPY --from=dependencies /opt/project-seed /opt/project-seed
RUN mkdir -p /opt/project-seed/node_modules/fixture-dep \
  && printf '%s' '{"name":"fixture-dep","types":"index.d.ts"}' > /opt/project-seed/node_modules/fixture-dep/package.json \
  && printf '%s\n' 'export const payment: { amount: number; currency: string };' > /opt/project-seed/node_modules/fixture-dep/index.d.ts \
  && python -m venv --without-pip /opt/project-venv \
  && /opt/project-venv/bin/python -c 'import sysconfig,pathlib; pathlib.Path(sysconfig.get_path("purelib"),"fixture_amount.py").write_text("def amount() -> int:\n    return 17\n")'
ENV HOME=/tmp
ENV VIRTUAL_ENV=/opt/project-venv
ENTRYPOINT ["factory-runtime-connector"]

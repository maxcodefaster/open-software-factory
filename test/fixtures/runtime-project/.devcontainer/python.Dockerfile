FROM docker.io/library/python:3.14.3-slim-bookworm@sha256:f21c0d5a44c56805654c15abccc1b2fd576c8d93aca0a3f74b4aba2dc92510e2
RUN useradd --create-home --uid 1000 node \
  && python -m venv --without-pip /opt/project-venv \
  && /opt/project-venv/bin/python -c 'import pathlib,sysconfig; pathlib.Path(sysconfig.get_path("purelib"), "fixture_amount.py").write_text("def amount() -> int:\n    return 17\n")'
ENV VIRTUAL_ENV=/opt/project-venv
ENV PATH=/opt/project-venv/bin:$PATH

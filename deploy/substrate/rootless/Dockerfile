# Qualified bootstrap base, NOT the Factory RuntimeHost/toolchain image.
FROM docker.io/library/docker@sha256:655682420c390d78bdac672dc9d35667fa1e52a760680657f6d45589047602fb
USER root
RUN apk add --no-cache util-linux python3 libcap-utils tinyproxy=1.11.2-r0 slirp4netns=1.3.1-r0 \
    && test "$(docker --version | cut -d' ' -f3 | tr -d ,)" = 29.0.0 \
    && test "$(tinyproxy -v)" = 'tinyproxy 1.11.2' \
    && setcap -r /usr/bin/newuidmap -r /usr/bin/newgidmap \
    && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap \
    && mkdir -p /opt/legacy-bin /home/rootless/persist \
    && for tool in iptables iptables-save iptables-restore ip6tables ip6tables-save ip6tables-restore; do \
         ln -s "/usr/sbin/${tool%%-*}-legacy${tool#${tool%%-*}}" "/opt/legacy-bin/$tool"; \
       done \
    && chown rootless:rootless /home/rootless/persist
COPY deploy/substrate/rootless/ /opt/factory-rootless/
RUN chmod 0555 /opt/factory-rootless/*.sh
ENV PATH="/opt/legacy-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    DOCKER_IPTABLES_LEGACY=1 DOCKER_TLS_CERTDIR="" \
    XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=unix:///run/user/1000/docker.sock
USER rootless
WORKDIR /home/rootless
ENTRYPOINT ["/opt/factory-rootless/start.sh"]

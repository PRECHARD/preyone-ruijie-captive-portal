FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        freeradius \
        freeradius-utils \
        libfreeradius3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Freeradius listens on the standard RADIUS UDP ports from the container.
EXPOSE 1812/udp 1813/udp

# Foreground + logs to stdout so `docker logs` works as usual.
CMD ["/usr/sbin/freeradius", "-f", "-l", "stdout"]
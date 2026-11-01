# Download Apprise deb package
FROM node:24.22.2-bookworm-slim AS download-apprise
WORKDIR /app
ARG APPRISE_VERSION=2.1.0-1
# APT verifies the signed Debian index and the package hash before the file is copied.
# Download only this package from sid; runtime dependencies still come from bookworm.
RUN apt-get update && \
    apt-get --yes --no-install-recommends install ca-certificates debian-archive-keyring && \
    printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian sid main' > /etc/apt/sources.list.d/apprise.list && \
    apt-get update && \
    apt-get download "apprise=${APPRISE_VERSION}" && \
    mv "apprise_${APPRISE_VERSION}_all.deb" apprise.deb

# Base Image (Slim)
# If the image changed, the second stage image should be changed too
FROM node:24.22.2-bookworm-slim AS base2-slim
ARG TARGETPLATFORM

# Specify --no-install-recommends to skip unused dependencies, make the base much smaller!
# sqlite3 = for debugging
# iputils-ping = for ping
# util-linux = for setpriv (Should be dropped in 2.0.0?)
# dumb-init = avoid zombie processes (#480)
# curl = for debugging
# ca-certificates = keep the cert up-to-date
# sudo = for start service nscd with non-root user
# nscd = for better DNS caching
RUN apt update && \
    apt --yes --no-install-recommends install  \
        sqlite3  \
        ca-certificates \
        iputils-ping  \
        util-linux  \
        dumb-init  \
        curl  \
        sudo \
        nscd && \
    rm -rf /var/lib/apt/lists/* && \
    apt --yes autoremove

# apprise = for notifications (Install from the deb package, as the stable one is too old) (workaround for #4867)
# Switching to testing repo is no longer working, as the testing repo is not bookworm anymore.
# python3-paho-mqtt (#4859)
# TODO: no idea how to delete the deb file after installation as it becomes a layer already
COPY --from=download-apprise /app/apprise.deb ./apprise.deb
RUN apt update && \
    apt --yes --no-install-recommends install ./apprise.deb python3-paho-mqtt && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f apprise.deb && \
    apt --yes autoremove

# Install cloudflared
RUN curl https://pkg.cloudflare.com/cloudflare-main.gpg --output /usr/share/keyrings/cloudflare-main.gpg && \
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' | tee /etc/apt/sources.list.d/cloudflared.list && \
    apt update && \
    apt install --yes --no-install-recommends cloudflared && \
    cloudflared version && \
    rm -rf /var/lib/apt/lists/* && \
    apt --yes autoremove

# For nscd
COPY ./docker/etc/nscd.conf /etc/nscd.conf
COPY ./docker/etc/sudoers /etc/sudoers

# Debian bookworm does not have Let's Encrypt's Gen Y root certs.
# Not sure if it is the best solution, and not sure if Debian will add them in the future, but for now we can just add them manually.
RUN curl -fsSL https://letsencrypt.org/certs/gen-y/root-ye.pem -o /usr/local/share/ca-certificates/isrg-root-ye.crt && \
    curl -fsSL https://letsencrypt.org/certs/gen-y/root-yr.pem -o /usr/local/share/ca-certificates/isrg-root-yr.crt && \
    update-ca-certificates

# Full Base Image
# MariaDB, Chromium and fonts
# Inherit the runtime built above, including this fork's Node version.
FROM base2-slim AS base2
ENV UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB=1
RUN apt update && \
    apt --yes --no-install-recommends install chromium fonts-indic fonts-noto fonts-noto-cjk mariadb-server && \
    rm -rf /var/lib/apt/lists/* && \
    apt --yes autoremove && \
    chown -R node:node /var/lib/mysql

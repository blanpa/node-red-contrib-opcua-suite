# Node-RED mit OPC UA Suite
FROM nodered/node-red:latest-minimal

# System-Abhängigkeiten installieren (für node-opcua native Module)
USER root
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

# Zurück zu node-red User
USER node-red

# OPC UA Suite in separates Verzeichnis kopieren
COPY --chown=node-red:node-red package.json /opt/opcua-suite/package.json
COPY --chown=node-red:node-red lib/ /opt/opcua-suite/lib/
COPY --chown=node-red:node-red nodes/ /opt/opcua-suite/nodes/
COPY --chown=node-red:node-red test-server/ /opt/opcua-suite/test-server/

# Zuerst node-opcua installieren, dann das lokale Paket
WORKDIR /usr/src/node-red
RUN cd /opt/opcua-suite && npm install --omit=dev --no-audit --no-fund && \
    cd /usr/src/node-red && npm install /opt/opcua-suite --no-audit --no-fund && \
    npm cache clean --force

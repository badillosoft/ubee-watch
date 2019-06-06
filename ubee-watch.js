const http = require("http");
const express = require("express");
const socket_io = require("socket.io");
const cors = require("cors");

function uuid(length = 256, radix = 32) {
    let token = "";
    while (token.length < length) {
        token += Math.random().toString(radix).slice(2);
    }
    return token.slice(0, length);
}

function random_select(array) {
    return array[Math.floor(Math.random() * array.length)];
}

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = socket_io(server);

const ambients = {};

function ambient_create(name, source, target, callback) {
    const token = uuid();
    ambients[token] = {
        name,
        source,
        target,
        created: new Date(),
        state: {
            place: "ambient:created",
            code: "created",
            source,
            at: new Date(),
        },
        trace: [],
        transfers: {},
    };

    !callback || callback({ token });
}

function ambient_state(token, code, protocol, callback) {
    const ambient = ambients[token];
    if (!ambient) {
        !callback || callback({ error: `invalid token` });
        return;
    }
    ambient.trace.push(ambient.state);
    ambient.state = {
        place: "ambient:state",
        code: code,
        protocol,
        at: new Date(),
    };
    const socket_source = io.sockets.connected[ambient.source];
    !socket_source || socket_source.emit("ambient:state", ambient.name, ambient.state.code, ambient.state.protocol);
    const socket_target = io.sockets.connected[ambient.target];
    !socket_target || socket_target.emit("ambient:state", token, ambient.name, ambient.state.code, ambient.state.protocol);
    !callback || callback({
        error: (!socket_source || !socket_target) ? `invalid source or target` : null,
        error_source: !socket_source ? `invalid source` : null,
        error_target: !socket_target ? `invalid target` : null,
    });
}

function ambient_create_transfer(token, type, channel, callback) {
    const ambient = ambients[token];
    if (!ambient) {
        !callback || callback({ error: `invalid token` });
        return;
    }
    const key = uuid();
    if (type === "source:target") {
        ambient.transfers[channel] = {
            type,
            key,
        };
        const socket_source = io.sockets.connected[ambient.source];
        if (!socket_source) {
            !callback || callback({ error: `invalid source` });
            return;
        }
        socket_source.emit("ambient:transfer", ambient.name, channel, key);
        !callback || callback(ambient.transfers[channel]);
        return;
    }
    if (type === "target:source") {
        ambient.transfers[channel] = {
            type,
            key,
        };
        const socket_target = io.sockets.connected[ambient.target];
        if (!socket_target) {
            !callback || callback({ error: `invalid target` });
            return;
        }
        socket_target.emit("ambient:transfer", ambient.name, channel, key);
        !callback || callback(ambient.transfers[channel]);
        return;
    }
    !callback || callback({ error: `invalid transfer:type` });
}

function ambient_transfer(token, channel, key, mode, protocol, data, callback) {
    const ambient = ambients[token];
    if (!ambient) {
        !callback || callback({ error: `invalid token` });
        return;
    }
    if (ambient.transfers[channel]) {
        !callback || callback({ error: `invalid transfer:channel` });
        return;
    }
    if (ambient.transfers[channel].key !== key) {
        !callback || callback({ error: `invalid transfer:key` });
        return;
    }
    if (ambient.transfers[channel].type === "source:target") {
        const socket_target = io.sockets.connected[ambient.target];
        if (!socket_target) {
            !callback || callback({ error: `invalid target` });
            return;
        }
        socket_target.emit("ambient:transfer", ambient.name, channel, mode, protocol, data);
        !callback || callback(ambient.transfers[channel]);
        return;
    }
    if (ambient.transfers[channel].type === "target:source") {
        const socket_source = io.sockets.connected[ambient.source];
        if (!socket_source) {
            !callback || callback({ error: `invalid source` });
            return;
        }
        socket_source.emit("ambient:transfer", ambient.name, channel, mode, protocol, data);
        !callback || callback(ambient.transfers[channel]);
        return;
    }
}

const watchers = {};
const lookers = {};

io.on("connection", socket => {
    console.log(`ubee-watch: socket connected`, socket.id);

    // socket.on("ambient:create", ambient_create);

    socket.on("ambient:state", ambient_state);

    socket.on("ambient:create/transfer", ambient_create_transfer);

    socket.on("ambient:transfer", ambient_transfer);

    socket.on("watch:login", (key, ambient, callback) => {
        watchers[socket.id] = watchers[socket.id] || {};
        watchers[socket.id][ambient] = {
            lookers: {}
        };
        !callback || callback({});
    });

    socket.on("look:login", (key, ambient, callback) => {
        const again = (intent = 0) => {
            if (intent >= 30) {
                !callback || callback({ error: `max intents exceed` });
                return;
            }

            const watch = random_select(
                Object.entries(watchers).filter(([watch_id, watcher]) => {
                    return !!watcher[ambient] && io.sockets.connected[watch_id];
                }).map(pair => pair[0])
            );
            if (!watch) {
                setTimeout(() => {
                    again(intent + 1);
                }, 100);
                return;
            }
            console.log("look:login", socket.id, watch, ambient);
            ambient_create(ambient, socket.id, watch, result => {
                if (result.error) {
                    !callback || callback(result);
                    return;
                }
                const token = result.token;
                lookers[socket.id] = lookers[socket.id] || {};
                lookers[socket.id][ambient] = {
                    watch,
                    token
                };
                watchers[watch][ambient].lookers[socket.id] = token;
                !callback || callback({ token });
            });
        };
        again();
    });
});

const port = process.argv[2] || process.env.PORT || 3000;

server.listen(port, () => {
    console.log(`ubee-watch: server started at http://localhost:${port}/`);
});
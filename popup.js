const statusEl = document.getElementById("status");
const startEl = document.getElementById("start-time");
const endEl = document.getElementById("end-time");

// ======================================================
// === SECCIÓN 1: FUNCIONES AUXILIARES
// ======================================================

function getCurrentTabId(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0] && tabs[0].id) {
            callback(tabs[0].id);
        } else {
            console.error("No se pudo encontrar la pestaña activa.");
            statusEl.textContent = "Error: No se encontro la pestaña.";
        }
    });
}

function getTabData(tabId, callback) {
    chrome.storage.session.get(["tabData"], (res) => {
        const tabData = res.tabData || {};
        callback(tabData[tabId] || {});
    });
}

function setTabData(tabId, key, value) {
    chrome.storage.session.get(["tabData"], (res) => {
        const tabData = res.tabData || {};
        if (!tabData[tabId]) {
            tabData[tabId] = {};
        }
        tabData[tabId][key] = value;
        chrome.storage.session.set({ tabData });
    });
}

function formatTime(seconds) {
    if (!seconds || seconds === 0) return "--:--";
    if (seconds > 1000000) {
        const date = new Date(seconds * 1000);
        return date.toLocaleTimeString();
    } else {
        return new Date(seconds * 1000).toISOString().substr(11, 8);
    }
}

function loadSavedTimes() {
    getCurrentTabId((tabId) => {
        getTabData(tabId, (data) => {
            startEl.textContent = formatTime(data.startTime);
            endEl.textContent = formatTime(data.endTime);
        });
    });
}

function resetTimes() {
    getCurrentTabId((tabId) => {
        setTabData(tabId, "startTime", 0);
        setTabData(tabId, "endTime", 0);

        startEl.textContent = formatTime(0);
        endEl.textContent = formatTime(0);
        statusEl.textContent = "Tiempos reseteados.";
    });
}

function requestCurrentTime(callback) {
    statusEl.textContent = "Obteniendo tiempo del video...";
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0] && tabs[0].url.includes("kick.com")) {
            chrome.tabs.sendMessage(
                tabs[0].id,
                { action: "getCurrentTime" },
                function (response) {
                    if (chrome.runtime.lastError) {
                        console.error(chrome.runtime.lastError.message);
                        statusEl.textContent =
                            "Error: Recarga la pagina de Kick.";
                        return;
                    }
                    if (response && response.success) {
                        statusEl.textContent = "Tiempo capturado.";
                        callback(response.time);
                    } else {
                        statusEl.textContent =
                            "Error: No se pudo obtener el tiempo.";
                        console.error(
                            response
                                ? response.error
                                : "Respuesta vacia del content script.",
                        );
                    }
                },
            );
        } else {
            statusEl.textContent = "Error: No estás en una pestaña de Kick.";
        }
    });
}

// ======================================================
// === SECCIÓN 2: EVENT LISTENERS
// ======================================================

document.getElementById("mark-start").addEventListener("click", () => {
    requestCurrentTime((time) => {
        startEl.textContent = formatTime(time);
        getCurrentTabId((tabId) => {
            setTabData(tabId, "startTime", time);
        });
    });
});

document.getElementById("mark-end").addEventListener("click", () => {
    requestCurrentTime((time) => {
        endEl.textContent = formatTime(time);
        getCurrentTabId((tabId) => {
            setTabData(tabId, "endTime", time);
        });
    });
});

// --- Listener 3: Clipear (Manual) Con tiempo marcado ---
document.getElementById("clip-now").addEventListener("click", () => {
    statusEl.textContent = "Validando...";

    getCurrentTabId((tabId) => {
        getTabData(tabId, (data) => {
            // Validaciones //
            if (!data.startTime || data.startTime <= 0) {
                statusEl.textContent = "Error: El 'Inicio' no esta marcado.";
                return;
            }
            if (!data.endTime || data.endTime <= 0) {
                statusEl.textContent = "Error: El 'Fin' no esta marcado.";
                return;
            }
            if (data.endTime <= data.startTime) {
                statusEl.textContent =
                    "Error: El 'Fin' debe ser despues del 'Inicio'.";
                return;
            }

            // === MENSAJE DE ERROR  ===
            if (!data.m3u8Url) {
                statusEl.textContent =
                    "Error: Video no cargado. Espera 2 seg y reintenta. (Verifica que estas en Kick)";
                return;
            }

            // Envío //
            statusEl.textContent = "Enviando orden de descarga (Buffer)...";
            chrome.runtime.sendMessage({
                action: "downloadVODClip",
                m3u8Url: data.m3u8Url,
                startTime: data.startTime,
                endTime: data.endTime,
                tabId: tabId, // Importante para el background
            });
        });
    });
});

document.getElementById("reset-times").addEventListener("click", resetTimes);
document.addEventListener("DOMContentLoaded", loadSavedTimes);

// --- Listener 6: Clip Rápido (Últimos 30s) ---
document.getElementById("clip-last-30").addEventListener("click", () => {
    handleQuickClip(30);
});

// --- Listener 7: Clip 120s ---
document.getElementById("clip-last-120").addEventListener("click", () => {
    handleQuickClip(120);
});

// --- Listener 8: Clip 180s ---
document.getElementById("clip-last-180").addEventListener("click", () => {
    handleQuickClip(180);
});

function handleQuickClip(seconds) {
    statusEl.textContent = `Iniciando clip de ${seconds}s...`;

    getCurrentTabId((tabId) => {
        getTabData(tabId, (data) => {
            // === MENSAJE DE ERROR  ===
            if (!data.m3u8Url) {
                statusEl.textContent =
                    "Error: Video no cargado. Espera 2 seg y reintenta. (Verifica que estas en Kick)";
                return;
            }

            statusEl.textContent = `Solicitando clip de ${seconds}s...`;

            chrome.runtime.sendMessage({
                action: `downloadLast${seconds}s`,
                m3u8Url: data.m3u8Url,
                tabId: tabId, // Enviamos tabId explícitamente por si acaso
            });
        });
    });
}

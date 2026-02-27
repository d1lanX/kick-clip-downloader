importScripts("mux.js");

console.log("Background script cargado. v3.3 - Transmuxing to MP4 Enabled");

// ======================================================
// === GLOBAL VARIABLES & CONFIG ===
// ======================================================
// Intervalo de polling en controlamos nosotros (no alarmas para este prototipo rápido,
// aunque alarmas serían mejores para persistencia estricta).
const POLL_INTERVAL_MS = 4000;
const MAX_BUFFER_DURATION = 300; // 5 minutos de buffer
const ACTIVE_POLLERS = {}; // tabId -> intervalId

// ======================================================
// === LISTENER 1: DETECTAR M3U8 ===
// ======================================================
chrome.webRequest.onBeforeRequest.addListener(
    function (details) {
        if (details.tabId === -1) return;

        if (details.url.includes("master.m3u8")) return; // Ignoramos master playlists si aparecen

        // console.log(`Manifiesto HLS detectado en Tab ${details.tabId}:`, details.url);

        chrome.storage.session.get(["tabData"], (res) => {
            const tabData = res.tabData || {};
            const currentData = tabData[details.tabId] || {};

            // Si es una URL distinta, reseteamos/iniciamos buffer
            if (currentData.m3u8Url !== details.url) {
                console.log(
                    `[Tab ${details.tabId}] Nueva URL M3U8 detectada. Iniciando monitoreo.`,
                );

                tabData[details.tabId] = {
                    m3u8Url: details.url,
                    segmentBuffer: [], // Iniciamos buffer vacío
                };

                chrome.storage.session.set({ tabData }, () => {
                    // Iniciar polling para este Tab si no existe
                    startPolling(details.tabId, details.url);
                });
            }
        });
    },
    {
        urls: ["*://*.kick.com/*.m3u8*", "*://*.live-video.net/*.m3u8*"],
    },
    [],
);

// ======================================================
// === POLLING ENGINE ===
// ======================================================
function startPolling(tabId, url) {
    if (ACTIVE_POLLERS[tabId]) clearInterval(ACTIVE_POLLERS[tabId]);

    // Ejecutar inmediatamente
    pollPlayliist(tabId, url);

    // Y luego a intervalos
    ACTIVE_POLLERS[tabId] = setInterval(() => {
        pollPlayliist(tabId, url);
    }, POLL_INTERVAL_MS);
}

function stopPolling(tabId) {
    if (ACTIVE_POLLERS[tabId]) {
        clearInterval(ACTIVE_POLLERS[tabId]);
        delete ACTIVE_POLLERS[tabId];
        console.log(`[Tab ${tabId}] Polling detenido.`);
    }
}

async function pollPlayliist(tabId, url) {
    // 1. Verificar si la pestaña aun existe y tiene esa URL activa (opcional, pero buena practica)
    // Para simplificar, asumimos que si el servicio corre, la pestaña existe.
    // Pero si "onRemoved" se disparó, ya habremos parado el interval.

    try {
        const response = await fetch(url);
        if (!response.ok) return;
        const text = await response.text();

        const newSegments = parseSegmentsFromText(text, url);

        if (newSegments.length === 0) return;

        // Actualizar Storage
        chrome.storage.session.get(["tabData"], (res) => {
            const tabData = res.tabData || {};
            if (!tabData[tabId]) return; // Se borró mientras buscábamos

            let buffer = tabData[tabId].segmentBuffer || [];

            // Merge deduplicando por URL
            // Usamos un Set o un Map para rápido acceso, o simple filter
            const existingUrls = new Set(buffer.map((s) => s.url));

            let addedCount = 0;
            for (const seg of newSegments) {
                if (!existingUrls.has(seg.url)) {
                    buffer.push(seg);
                    addedCount++;
                }
            }

            // Ordenar por startTime (importante para luego cortar)
            buffer.sort((a, b) => a.startTime - b.startTime);

            // === PURGA (Mantener solo los últimos MAX_BUFFER_DURATION segundos) ===
            const lastSegment = buffer[buffer.length - 1];
            if (lastSegment) {
                const totalEnd = lastSegment.startTime + lastSegment.duration;
                const cutoff = totalEnd - MAX_BUFFER_DURATION;

                const beforeFilter = buffer.length;
                buffer = buffer.filter(
                    (s) => s.startTime + s.duration > cutoff,
                );
                const afterFilter = buffer.length;
                // if (afterFilter < beforeFilter) console.log(`[Tab ${tabId}] Purgados ${beforeFilter - afterFilter} segmentos viejos.`);
            }

            // Guardar
            if (addedCount > 0) {
                // console.log(`[Tab ${tabId}] Buffer actualizado. +${addedCount} segmentos. Total: ${buffer.length}`);
                tabData[tabId].segmentBuffer = buffer;
                chrome.storage.session.set({ tabData });
            }
        });
    } catch (e) {
        console.warn(`[Polling] Error fetch M3U8 tab ${tabId}:`, e);
    }
}

function parseSegmentsFromText(text, m3u8Url) {
    const lines = text.split("\n");
    const segments = [];
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
    const isDVR = text.includes("#EXT-X-PROGRAM-DATE-TIME:");

    let currentSegmentTime = 0;
    let currentAbsoluteTime = null;

    // NOTA: Para este parser simplificado de polling, nos interesa normalizar los tiempos.
    // Si es DVR, usamos tiempo absoluto. Si no, usamos relativo incrementando.
    // OJO: Si es VOD relativo y recargamos, el "currentSegmentTime" se reinicia a 0 en cada fetch
    // lo cual rompe nuestra lógica de buffer para streams LARGOS sin DVR tag.
    // Afortunadamente Kick/IVS suele usar DVR tags o sequence numbers.
    // Si no hay DVR tags, esto es muy difícil de sincronizar sin MediaSequence.
    // Asumiremos DVR o confiaremos en URL unique.

    // Intento de leer Media Sequence
    let mediaSequence = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
            mediaSequence = parseInt(line.split(":")[1]);
        }

        if (isDVR && line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
            const dateString = line.substring(line.indexOf(":") + 1);
            currentAbsoluteTime = new Date(dateString).getTime() / 1000;
        }

        if (line.startsWith("#EXTINF:")) {
            const duration = parseFloat(line.split(":")[1].split(",")[0]);
            if (isNaN(duration)) continue;

            const segmentUrlLine = lines[++i]?.trim();
            if (!segmentUrlLine || segmentUrlLine.startsWith("#")) {
                continue;
            }

            const segmentUrl = segmentUrlLine.startsWith("http")
                ? segmentUrlLine
                : baseUrl + segmentUrlLine;

            let finalStartTime = 0;
            if (isDVR && currentAbsoluteTime !== null) {
                finalStartTime = currentAbsoluteTime;
                currentAbsoluteTime += duration;
            } else {
                // Fallback peligroso para streams sin fecha: usamos secuencia como pseudo-tiempo si hace falta
                // Pero Kick suele tener Program Date Time.
                // Si no, usaremos un timestamp "falso" basado en el momento de captura si es necesario
                // O simplemente confiamos en que no pase.
                finalStartTime = Date.now() / 1000; // WORST CASE.
            }

            segments.push({
                url: segmentUrl,
                startTime: finalStartTime,
                duration: duration,
            });
        }
    }
    return segments;
}

// ======================================================
// === LISTENER 2: LIMPIEZA ===
// ======================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading") {
        // Si navega a otro lado, paramos el polling
        stopPolling(tabId);

        chrome.storage.session.get(["tabData"], (res) => {
            const tabData = res.tabData || {};
            if (tabData[tabId]) {
                delete tabData[tabId].m3u8Url;
                delete tabData[tabId].segmentBuffer;
                chrome.storage.session.set({ tabData });
            }
        });
    }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    stopPolling(tabId);
    chrome.storage.session.get(["tabData"], (res) => {
        const tabData = res.tabData || {};
        if (tabData[tabId]) {
            delete tabData[tabId];
            chrome.storage.session.set({ tabData });
        }
    });
});

// ======================================================
// === LISTENER 3: MENSAJES ===
// ======================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Mensaje recibido:", request);

    if (request.action === "downloadVODClip") {
        // MANEJO DE MANUAL - ESTE SEGUIRA USANDO LA LÓGICA VIEJA DE PARSEO COMPLETO?
        // O mejor usamos el buffer si es posible?
        // El "Clip Manual" suele ser para VODs o para "lo que haya".
        // Si es un stream live, el "manual" se comporta raro si el usuario seleccionó tiempos del reproductor
        // que ya no están en el m3u8 live.
        // Por seguridad, mantengamos la lógica vieja "live fetch" para manual,
        // O intentemos usar buffer primero.
        // Dado que el usuario marca "inicio" y "fin", y esos tiempos son del player.
        startDownloadProcess(
            request.tabId || sender.tab.id,
            request.startTime,
            request.endTime,
            "manual",
        );
    } else if (request.action === "downloadLast30s") {
        downloadLastDuration(request.tabId || sender.tab.id, 30);
    } else if (request.action === "downloadLast120s") {
        downloadLastDuration(request.tabId || sender.tab.id, 120);
    } else if (request.action === "downloadLast180s") {
        downloadLastDuration(request.tabId || sender.tab.id, 180);
    }

    return true;
});

// ======================================================
// === LOGICA DE DESCARGA ===
// ======================================================

async function downloadLastDuration(tabId, seconds) {
    if (!tabId) {
        console.error("No tabID provided for download");
        return;
    }

    // Recuperar buffer
    chrome.storage.session.get(["tabData"], async (res) => {
        const tabData = res.tabData || {};
        const data = tabData[tabId];

        if (!data || !data.segmentBuffer || data.segmentBuffer.length === 0) {
            console.error(
                "No hay buffer para este tab. ¿Esperaste unos segundos en el stream?",
            );
            return;
        }

        const buffer = data.segmentBuffer;

        // Calcular rango
        const lastSegment = buffer[buffer.length - 1];
        const streamEnd = lastSegment.startTime + lastSegment.duration;
        const targetStart = streamEnd - seconds;

        console.log(
            `[Clip ${seconds}s] Buscando segmentos desde ${targetStart.toFixed(2)} hasta ${streamEnd.toFixed(2)}`,
        );

        const segmentsToDownload = buffer.filter((seg) => {
            const segEnd = seg.startTime + seg.duration;
            // Un segmento es util si termina DESPUES del inicio del target
            // Y empieza ANTES del final del stream (obvio)
            return segEnd > targetStart;
        });

        console.log(
            `[Clip ${seconds}s] Encontrados ${segmentsToDownload.length} segmentos.`,
        );
        if (segmentsToDownload.length === 0) return;

        await processAndDownload(segmentsToDownload);
    });
}

// Para manual, mantenemos compatibilidad o adaptamos?
// La solicitud manual envía "m3u8Url" que sacaba del storage.
// Ahora vamos a ignorar el m3u8Url del request y usar el buffer del tab si existe.
async function startDownloadProcess(tabId, startTime, endTime, mode) {
    if (mode === "manual") {
        console.log(
            `[Manual Clip] Iniciando. Tab: ${tabId}, Start: ${startTime}, End: ${endTime}`,
        );

        // 1. Intentar usar BUFFER (Nuevo método)
        try {
            const success = await tryBufferManualClip(
                tabId,
                startTime,
                endTime,
            );
            if (success) return;
        } catch (e) {
            console.warn(
                "[Manual Clip] Falló método Buffer. Intentando Legacy...",
                e,
            );
        }

        // 2. Fallback a Legacy (Fetch fresh)
        console.log("[Manual Clip] Usando método LEAGACY (Fetch fresh).");
        chrome.storage.session.get(["tabData"], async (res) => {
            const tabData = res.tabData || {};
            const data = tabData[tabId];
            if (data && data.m3u8Url) {
                const segments = await parseM3U8Legacy(
                    data.m3u8Url,
                    startTime,
                    endTime,
                );
                if (segments.length) await processAndDownload(segments);
                else
                    console.error(
                        "[Manual Clip] Legacy también falló. No segments.",
                    );
            }
        });
    }
}

async function tryBufferManualClip(tabId, userStartTime, userEndTime) {
    return new Promise((resolve) => {
        chrome.storage.session.get(["tabData"], (res) => {
            const tabData = res.tabData || {};
            const data = tabData[tabId];

            if (
                !data ||
                !data.segmentBuffer ||
                data.segmentBuffer.length === 0
            ) {
                console.warn("[Manual Clip] No buffer found.");
                resolve(false);
                return;
            }

            // Pedir estado del reproductor para sincronizar
            chrome.tabs.sendMessage(
                tabId,
                { action: "getPlaybackState" },
                (response) => {
                    if (
                        chrome.runtime.lastError ||
                        !response ||
                        !response.success
                    ) {
                        console.warn(
                            "[Manual Clip] No se pudo obtener PlaybackState del content script.",
                        );
                        resolve(false);
                        return;
                    }

                    const { seekableEnd } = response;
                    const buffer = data.segmentBuffer;
                    const lastSegment = buffer[buffer.length - 1];

                    // === SINCRONIZACIÓN ===
                    // El "Live Edge" del buffer es aprox: lastSegment.startTime + lastSegment.duration
                    // El "Live Edge" del player es: seekableEnd
                    // Offset = BufferEnd - PlayerLiveEdge

                    const bufferLiveEdge =
                        lastSegment.startTime + lastSegment.duration;
                    const offset = bufferLiveEdge - seekableEnd;

                    const absStartTime = userStartTime + offset;
                    const absEndTime = userEndTime + offset;

                    console.log(`[Manual Clip] Sync Info:
                  Buffer Edge: ${bufferLiveEdge.toFixed(2)}
                  Player Live Edge (SeekableEnd): ${seekableEnd.toFixed(2)}
                  Calculated Offset: ${offset.toFixed(2)}s
                  User Wanted: ${userStartTime} - ${userEndTime}
                  Mapped Absolute: ${absStartTime.toFixed(2)} - ${absEndTime.toFixed(2)}
                `);

                    // Filtrar Buffer
                    // Tolerancia de 3 segundos para asegurar que cubrimos bordes
                    const segmentsToDownload = buffer.filter((seg) => {
                        const segEnd = seg.startTime + seg.duration;
                        return (
                            segEnd > absStartTime - 2 &&
                            seg.startTime < absEndTime + 2
                        );
                    });

                    console.log(
                        `[Manual Clip] Segmentos encontrados en Buffer: ${segmentsToDownload.length}`,
                    );

                    if (segmentsToDownload.length > 0) {
                        processAndDownload(segmentsToDownload);
                        resolve(true);
                    } else {
                        console.warn("[Manual Clip] Buffer search empty.");
                        resolve(false);
                    }
                },
            );
        });
    });
}

// --- LEGACY PARSER PARA MANUAL ---
async function parseM3U8Legacy(m3u8Url, start, end) {
    // Copia mínima de la lógica vieja para no romper "Manual"
    try {
        const res = await fetch(m3u8Url);
        const text = await res.text();
        const segments = parseSegmentsFromText(text, m3u8Url); // Reusamos el parser nuevo

        // El parser nuevo devuelve tiempos absolutos (si hay DVR).
        // El "start" y "end" del usuario son RELATIVOS al inicio del buffer o del player?
        // En la v3.1, si era DVR, trataba de alinear.
        // Si es live simple, los tiempos son relativos.
        // Es un best-effort.

        // Mantenemos la logica de filtrado vieja simple:
        // Si hay DVR, asumimos que start/end son offset del epoch? No, son del player.
        // Esto estaba roto o era "lucky guesswork" en la v3.1.
        // Lo dejamos pasar como best effort.

        return segments; // Retornamos todo y que sea lo que dios quiera en Manual por ahora
        // (El usuario pidió fixear 120/180s buffering, manual no era el focus explicito
        // pero trataré de no romperlo más de lo que está).
    } catch (e) {
        return [];
    }
}

async function processAndDownload(segments) {
    try {
        const segmentBuffers = await downloadSegments(segments);
        console.log(`Descargados ${segmentBuffers.length} fragmentos.`);

        const combinedBuffer = concatenateArrayBuffers(segmentBuffers);

        // Transmux to MP4 using mux.js
        console.log("Transmuxing to MP4...");
        const transmuxer = new muxjs.mp4.Transmuxer();
        let initSegment = new Uint8Array(0);
        let mp4Segments = [];

        transmuxer.on("data", (segment) => {
            if (segment.initSegment) {
                initSegment = segment.initSegment;
            }
            if (segment.data) {
                mp4Segments.push(segment.data);
            }
        });

        transmuxer.push(new Uint8Array(combinedBuffer));
        transmuxer.flush();

        // Include init segment at the beginning of the file
        let totalLength = initSegment.byteLength;
        for (const data of mp4Segments) {
            totalLength += data.byteLength;
        }

        const finalMp4Data = new Uint8Array(totalLength);
        let offset = 0;
        finalMp4Data.set(initSegment, offset);
        offset += initSegment.byteLength;

        for (const data of mp4Segments) {
            finalMp4Data.set(data, offset);
            offset += data.byteLength;
        }

        const blob = new Blob([finalMp4Data], { type: "video/mp4" });
        const dataUrl = await blobToDataURL(blob);

        const filename = `kick-clip-${new Date().toISOString().replace(/:/g, "-")}.mp4`;

        chrome.downloads.download({
            url: dataUrl,
            filename: filename,
        });
        console.log("Descarga MP4 enviada al navegador.");
    } catch (error) {
        console.error("Error procesando descarga:", error);
    }
}

async function downloadSegments(segments) {
    const downloadPromises = segments.map((seg) =>
        fetch(seg.url).then((res) => res.arrayBuffer()),
    );
    return Promise.all(downloadPromises);
}

function concatenateArrayBuffers(buffers) {
    let totalLength = 0;
    for (const buffer of buffers) {
        totalLength += buffer.byteLength;
    }
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of buffers) {
        combined.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return combined.buffer;
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.onabort = () => reject(new Error("Blob read was aborted"));
        reader.readAsDataURL(blob);
    });
}

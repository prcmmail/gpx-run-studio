
/* ==========================================================
   GPX RUN STUDIO
   Mapa, percursos, estatísticas, altimetria e exportação GPX
   ========================================================== */

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    map: $("map"),
    mapHint: $("mapHint"),
    routeType: $("routeType"),
    routeDistance: $("routeDistance"),
    createRouteBtn: $("createRouteBtn"),
    clearRouteBtn: $("clearRouteBtn"),
    newRouteBtn: $("newRouteBtn"),
    exportBtn: $("exportBtn"),
    distance: $("distance"),
    altitudeRange: $("altitudeRange"),
    descent: $("descent"),
    ascent: $("ascent"),
    pointCount: $("pointCount"),
    loadElevationBtn: $("loadElevationBtn"),
    elevationStatus: $("elevationStatus"),
    chartDistance: $("chartDistance"),
    elevationChart: $("elevationChart"),
    themeSelect: $("themeSelect"),
    mapType: $("mapType"),
    status: $("status")
  };

  const ALTITUDE_API = "https://api.open-meteo.com/v1/elevation";

  const themes = [
    "dark", "light", "garmin", "strava",
    "midnight", "forest", "ocean", "sunset"
  ];

  let map;
  let routeLine;
  let markers = [];
  let points = [];
  let altitudes = [];
  let tileLayer;
  let chartCanvas = null;
  let elevationLoading = false;
  let requestNumber = 0;

  const tileSources = {
    street: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }
    },

    satellite: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: {
        maxZoom: 19,
        attribution: "Tiles &copy; Esri"
      }
    },

    terrain: {
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 17,
        attribution:
          'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap'
      }
    }
  };

  /* -------------------- UTILITÁRIOS -------------------- */

  function setStatus(message) {
    if (el.status) el.status.textContent = message;
  }

  function setHint(message) {
    if (el.mapHint) el.mapHint.textContent = message;
  }

  function setElevationStatus(message) {
    if (el.elevationStatus) {
      el.elevationStatus.textContent = message;
    }
  }

  function formatNumber(value, decimals = 2) {
    if (!Number.isFinite(value)) return "—";

    return value.toLocaleString("pt-PT", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function validAltitudeValues() {
    return (
      points.length >= 2 &&
      altitudes.length === points.length &&
      altitudes.every(Number.isFinite)
    );
  }

  function distanceBetween(a, b) {
    const radius = 6371000;
    const radians = (degrees) => degrees * Math.PI / 180;

    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const deltaLat = radians(b.lat - a.lat);
    const deltaLng = radians(b.lng - a.lng);

    const h =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(deltaLng / 2) ** 2;

    return 2 * radius * Math.asin(
      Math.min(1, Math.sqrt(h))
    );
  }

  function routeDistanceMeters() {
    if (points.length < 2) return 0;

    let total = 0;

    for (let i = 1; i < points.length; i++) {
      total += distanceBetween(points[i - 1], points[i]);
    }

    if (el.routeType.value === "circular" && points.length > 2) {
      const first = points[0];
      const last = points[points.length - 1];

      if (distanceBetween(first, last) > 2) {
        total += distanceBetween(last, first);
      }
    }

    return total;
  }

  function cumulativeDistancesKm() {
    const result = [0];
    let total = 0;

    for (let i = 1; i < points.length; i++) {
      total += distanceBetween(points[i - 1], points[i]);
      result.push(total / 1000);
    }

    return result;
  }

  function clearAltitudeData() {
    // Invalida pedidos de altitude que ainda estejam em curso.
    requestNumber++;
    elevationLoading = false;

    if (el.loadElevationBtn) {
      el.loadElevationBtn.disabled = false;
    }

    altitudes = [];

    setElevationStatus("Carrega a altimetria para obter as altitudes.");
    renderChartPlaceholder("Cria um percurso e carrega a altimetria.");
    updateStats();
  }

  /* -------------------- MAPA -------------------- */

  function initMap() {
    if (!window.L) {
      setStatus(
        "Não foi possível carregar o mapa. Verifica a ligação à Internet."
      );
      setHint("A biblioteca do mapa não foi carregada.");
      return;
    }

    map = L.map("map", {
      zoomControl: true,
      preferCanvas: true
    }).setView([39.6, -8.0], 7);

    // VISTA PREDEFINIDA: SATÉLITE
    setTileLayer("satellite");

    // Mantém o seletor sincronizado com a camada inicial.
    el.mapType.value = "satellite";

    routeLine = L.polyline([], {
      color: "#fc642d",
      weight: 5,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(map);

    map.on("click", (event) => {
      addPoint({
        lat: event.latlng.lat,
        lng: event.latlng.lng
      });

      setStatus("Ponto acrescentado ao percurso.");
    });

    setTimeout(() => map.invalidateSize(), 150);
  }

  function setTileLayer(type) {
    if (!map) return;

    // Usa apenas os estilos de mapa disponíveis.
    const selectedType = tileSources[type] ? type : "satellite";
    const source = tileSources[selectedType];

    if (tileLayer) {
      map.removeLayer(tileLayer);
    }

    tileLayer = L.tileLayer(source.url, source.options);

    tileLayer.on("tileerror", () => {
      setStatus(
        "Algumas imagens do mapa não carregaram. Verifica a ligação à Internet."
      );
    });

    tileLayer.addTo(map);

    // Mantém sempre o seletor atualizado.
    if (el.mapType && el.mapType.value !== selectedType) {
      el.mapType.value = selectedType;
    }
  }

  function updateRouteLine() {
    if (!routeLine) return;

    const latLngs = points.map((point) => [
      point.lat,
      point.lng
    ]);

    if (
      el.routeType.value === "circular" &&
      points.length > 2 &&
      distanceBetween(points[0], points[points.length - 1]) > 2
    ) {
      latLngs.push([points[0].lat, points[0].lng]);
    }

    routeLine.setLatLngs(latLngs);

    const accent = getComputedStyle(document.body)
      .getPropertyValue("--accent")
      .trim();

    routeLine.setStyle({
      color: accent || "#fc642d"
    });
  }

  function updateMarkers() {
    if (!map) return;

    markers.forEach((marker) => map.removeLayer(marker));
    markers = [];

    points.forEach((point, index) => {
      const marker = L.marker(
        [point.lat, point.lng],
        {
          draggable: true,
          autoPan: true,
          title: `Ponto ${index + 1}`
        }
      ).addTo(map);

      marker.bindTooltip(`Ponto ${index + 1}`);

      marker.on("dragend", () => {
        const position = marker.getLatLng();

        points[index] = {
          lat: position.lat,
          lng: position.lng
        };

        clearAltitudeData();
        updateRouteLine();
        updateStats();
        updateMarkers();

        setStatus(
          `Localização do ponto ${index + 1} atualizada.`
        );
      });

      marker.on("contextmenu", () => {
        removePoint(index);
      });

      markers.push(marker);
    });
  }

  function addPoint(point) {
    if (
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lng)
    ) {
      return;
    }

    points.push({
      lat: point.lat,
      lng: point.lng
    });

    clearAltitudeData();
    updateMarkers();
    updateRouteLine();
    updateStats();

    setHint("Arrasta os marcadores para ajustar o percurso.");
  }

  function removePoint(index) {
    if (index < 0 || index >= points.length) return;

    points.splice(index, 1);

    clearAltitudeData();
    updateMarkers();
    updateRouteLine();
    updateStats();

    setStatus("Ponto removido.");
  }

  function fitRoute() {
    if (!map || points.length === 0) return;

    if (points.length === 1) {
      map.setView(
        [points[0].lat, points[0].lng],
        15
      );
      return;
    }

    const bounds = L.latLngBounds(
      points.map((point) => [point.lat, point.lng])
    );

    map.fitBounds(bounds, {
      padding: [35, 35],
      maxZoom: 16
    });
  }

  /* -------------------- CRIAR PERCURSOS -------------------- */

  function createRoute() {
    if (!map) return;

    const distanceKm = Number(el.routeDistance.value);

    if (
      !Number.isFinite(distanceKm) ||
      distanceKm < 0.5 ||
      distanceKm > 100
    ) {
      setStatus("Indica uma distância entre 0,5 e 100 km.");
      return;
    }

    const center = map.getCenter();
    const targetMeters = distanceKm * 1000;

    points = [];
    clearAltitudeData();

    if (el.routeType.value === "circular") {
      // Circuito aproximado; não segue automaticamente estradas ou trilhos.
      const count = Math.max(
        24,
        Math.min(120, Math.ceil(distanceKm * 5))
      );

      const radius = targetMeters / (2 * Math.PI);
      const latRadians = center.lat * Math.PI / 180;
      const latOffset = radius / 111320;
      const lngOffset = radius /
        (111320 * Math.max(0.15, Math.cos(latRadians)));

      for (let i = 0; i < count; i++) {
        const angle = (2 * Math.PI * i) / count;

        points.push({
          lat: center.lat + latOffset * Math.sin(angle),
          lng: center.lng + lngOffset * Math.cos(angle)
        });
      }
    } else {
      // Segmento inicial em linha reta, de comprimento aproximado.
      const latRadians = center.lat * Math.PI / 180;
      const latOffset = (targetMeters / 2) / 111320;
      const lngOffset = (targetMeters / 2) /
        (111320 * Math.max(0.15, Math.cos(latRadians)));

      points = [
        {
          lat: center.lat,
          lng: center.lng - lngOffset
        },
        {
          lat: center.lat,
          lng: center.lng + lngOffset
        }
      ];
    }

    updateMarkers();
    updateRouteLine();
    updateStats();
    fitRoute();

    setHint("Percurso criado. Arrasta os pontos para o ajustar.");
    setStatus(
      "Percurso aproximado criado. Ajusta os pontos no mapa."
    );
  }

  function clearRoute() {
    points = [];

    clearAltitudeData();
    updateMarkers();
    updateRouteLine();
    updateStats();

    setHint("Clica no mapa para adicionar pontos.");
    setStatus("Percurso limpo.");
  }

  function newRoute() {
    clearRoute();

    el.routeDistance.value = "5";
    el.routeType.value = "linear";

    updateRouteLine();
    updateStats();

    setStatus("Novo percurso pronto a criar.");
  }

  /* -------------------- ESTATÍSTICAS -------------------- */

  function updateStats() {
    if (!el.distance) return;

    const distanceKm = routeDistanceMeters() / 1000;

    el.distance.textContent = `${formatNumber(distanceKm)} km`;
    el.pointCount.textContent = String(points.length);
    el.chartDistance.textContent = `${formatNumber(distanceKm)} km`;

    if (!validAltitudeValues()) {
      el.altitudeRange.textContent = "— / — m";
      el.ascent.textContent = "— m";
      el.descent.textContent = "— m";
      return;
    }

    const minAltitude = Math.min(...altitudes);
    const maxAltitude = Math.max(...altitudes);

    el.altitudeRange.textContent =
      `${formatNumber(minAltitude, 0)} / ${formatNumber(maxAltitude, 0)} m`;

    let totalAscent = 0;
    let totalDescent = 0;

    for (let i = 1; i < altitudes.length; i++) {
      const delta = altitudes[i] - altitudes[i - 1];

      if (delta > 0) totalAscent += delta;
      if (delta < 0) totalDescent += Math.abs(delta);
    }

    el.ascent.textContent = `${formatNumber(totalAscent, 0)} m`;
    el.descent.textContent = `${formatNumber(totalDescent, 0)} m`;
  }

  /* -------------------- ALTIMETRIA -------------------- */

  async function loadElevation() {
    if (points.length < 2) {
      setElevationStatus(
        "Adiciona pelo menos dois pontos antes de carregar a altimetria."
      );
      setStatus("O percurso precisa de pelo menos dois pontos.");
      return;
    }

    if (elevationLoading) return;

    elevationLoading = true;
    el.loadElevationBtn.disabled = true;

    const thisRequest = ++requestNumber;
    const snapshot = points.map((point) => ({ ...point }));

    setElevationStatus("A obter dados de altitude...");
    setStatus("A carregar altimetria.");

    try {
      const results = [];

      for (let start = 0; start < snapshot.length; start += 50) {
        if (thisRequest !== requestNumber) return;

        const batch = snapshot.slice(start, start + 50);
        const latitudes = batch.map((p) => p.lat).join(",");
        const longitudes = batch.map((p) => p.lng).join(",");

        const url =
          `${ALTITUDE_API}?latitude=${encodeURIComponent(latitudes)}` +
          `&longitude=${encodeURIComponent(longitudes)}`;

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(
            `O serviço de altitude respondeu com o código ${response.status}.`
          );
        }

        const data = await response.json();

        if (!Array.isArray(data.elevation)) {
          throw new Error(
            "A resposta do serviço não contém altitudes válidas."
          );
        }

        results.push(...data.elevation.map((value) => {
          if (
            value === null ||
            value === undefined ||
            value === ""
          ) {
            return null;
          }

          const number = Number(value);
          return Number.isFinite(number) ? number : null;
        }));
      }

      if (thisRequest !== requestNumber) return;

      const routeChanged =
        snapshot.length !== points.length ||
        snapshot.some((point, index) =>
          point.lat !== points[index].lat ||
          point.lng !== points[index].lng
        );

      if (routeChanged) {
        throw new Error(
          "O percurso mudou durante o carregamento. Tenta novamente."
        );
      }

      if (
        results.length !== points.length ||
        results.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          "Não foi possível obter uma altitude válida para cada ponto."
        );
      }

      altitudes = results;

      updateStats();
      drawElevationChart();

      setElevationStatus("Altimetria carregada.");
      setStatus("Altitudes atualizadas com sucesso.");
    } catch (error) {
      if (thisRequest !== requestNumber) return;

      console.error("Erro ao carregar altimetria:", error);

      setElevationStatus(
        error instanceof TypeError
          ? "Falha de ligação ao serviço de altitude. Verifica a Internet e tenta novamente."
          : error.message
      );

      setStatus("Não foi possível carregar a altimetria.");
    } finally {
      if (thisRequest === requestNumber) {
        elevationLoading = false;
        el.loadElevationBtn.disabled = false;
      }
    }
  }

  /* -------------------- GRÁFICO DE ELEVAÇÃO -------------------- */

  function renderChartPlaceholder(message) {
    chartCanvas = null;

    el.elevationChart.replaceChildren();

    const paragraph = document.createElement("p");
    paragraph.textContent = message;

    el.elevationChart.appendChild(paragraph);
  }

  function createChartCanvas() {
    el.elevationChart.replaceChildren();

    chartCanvas = document.createElement("canvas");

    chartCanvas.setAttribute("role", "img");
    chartCanvas.setAttribute(
      "aria-label",
      "Gráfico do perfil de elevação do percurso"
    );

    el.elevationChart.appendChild(chartCanvas);
  }

  function drawElevationChart() {
    if (!validAltitudeValues()) {
      renderChartPlaceholder(
        "Carrega a altimetria para visualizar o perfil."
      );
      return;
    }

    if (!chartCanvas || !chartCanvas.isConnected) {
      createChartCanvas();
    }

    const canvas = chartCanvas;
    const width = Math.max(
      280,
      Math.floor(el.elevationChart.clientWidth)
    );
    const height = 230;
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.body);

    const textColor =
      style.getPropertyValue("--text-muted").trim() || "#9ba8b6";

    const accent =
      style.getPropertyValue("--accent").trim() || "#fc642d";

    const border =
      style.getPropertyValue("--border").trim() || "#303b48";

    const padding = {
      top: 22,
      right: 18,
      bottom: 32,
      left: 48
    };

    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    const minAltitude = Math.min(...altitudes);
    const maxAltitude = Math.max(...altitudes);
    const altitudeRange = Math.max(1, maxAltitude - minAltitude);
    const distances = cumulativeDistancesKm();
    const totalDistance = Math.max(
      0.001,
      routeDistanceMeters() / 1000
    );

    const x = (index) => {
      if (points.length <= 1) return padding.left;

      return padding.left +
        (distances[index] / totalDistance) * graphWidth;
    };

    const y = (altitude) =>
      padding.top +
      (1 - (altitude - minAltitude) / altitudeRange) * graphHeight;

    // Grelha e etiquetas de altitude.
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = "10px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 3; i++) {
      const fraction = i / 3;
      const yy = padding.top + fraction * graphHeight;
      const altitude = maxAltitude - fraction * altitudeRange;

      ctx.beginPath();
      ctx.moveTo(padding.left, yy);
      ctx.lineTo(width - padding.right, yy);
      ctx.stroke();

      ctx.fillText(
        `${Math.round(altitude)} m`,
        padding.left - 7,
        yy
      );
    }

    // Área preenchida sob o perfil.
    const gradient = ctx.createLinearGradient(
      0,
      padding.top,
      0,
      padding.top + graphHeight
    );

    gradient.addColorStop(0, accent + "66");
    gradient.addColorStop(1, accent + "08");

    ctx.beginPath();
    ctx.moveTo(x(0), padding.top + graphHeight);

    for (let i = 0; i < altitudes.length; i++) {
      ctx.lineTo(x(i), y(altitudes[i]));
    }

    ctx.lineTo(
      x(altitudes.length - 1),
      padding.top + graphHeight
    );

    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Linha do perfil.
    ctx.beginPath();

    altitudes.forEach((altitude, index) => {
      if (index === 0) {
        ctx.moveTo(x(index), y(altitude));
      } else {
        ctx.lineTo(x(index), y(altitude));
      }
    });

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Pontos inicial e final.
    for (const index of [0, altitudes.length - 1]) {
      ctx.beginPath();
      ctx.arc(x(index), y(altitudes[index]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    ctx.fillStyle = textColor;
    ctx.font = "10px Arial";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText("0 km", padding.left, height - 10);

    ctx.textAlign = "right";
    ctx.fillText(
      `${formatNumber(totalDistance)} km`,
      width - padding.right,
      height - 10
    );
  }

  /* -------------------- EXPORTAÇÃO GPX -------------------- */

  function exportGPX() {
    if (points.length < 2) {
      setStatus(
        "Adiciona pelo menos dois pontos antes de exportar."
      );
      return;
    }

    const escapeXML = (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

    const hasAltitude = validAltitudeValues();

    const trackPoints = points.map((point, index) => {
      const elevation = hasAltitude
        ? `\n      <ele>${altitudes[index].toFixed(1)}</ele>`
        : "";

      return (
        `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">` +
        `${elevation}\n      </trkpt>`
      );
    });

    // Fecha o circuito no ponto inicial, quando necessário.
    if (
      el.routeType.value === "circular" &&
      points.length > 2 &&
      distanceBetween(points[0], points[points.length - 1]) > 2
    ) {
      const first = points[0];

      const elevation = hasAltitude
        ? `\n      <ele>${altitudes[0].toFixed(1)}</ele>`
        : "";

      trackPoints.push(
        `      <trkpt lat="${first.lat.toFixed(7)}" lon="${first.lng.toFixed(7)}">` +
        `${elevation}\n      </trkpt>`
      );
    }

    const now = new Date().toISOString();

    const name = el.routeType.value === "circular"
      ? "Percurso circular"
      : "Percurso linear";

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1"
     creator="GPX Run Studio"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 https://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXML(name)}</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${escapeXML(name)}</name>
    <trkseg>
${trackPoints.join("\n")}
    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpx], {
      type: "application/gpx+xml;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "percurso.gpx";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus(
      hasAltitude
        ? "Ficheiro GPX exportado com altitudes."
        : "Ficheiro GPX exportado sem altitudes. Carrega a altimetria para as incluir."
    );
  }

  /* -------------------- TEMA E EVENTOS -------------------- */

  function applyTheme(theme) {
    if (!themes.includes(theme)) theme = "dark";

    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
    document.documentElement.style.colorScheme =
      theme === "light" ? "light" : "dark";

    if (el.themeSelect.value !== theme) {
      el.themeSelect.value = theme;
    }

    updateRouteLine();

    if (validAltitudeValues()) {
      drawElevationChart();
    }
  }

  function bindEvents() {
    el.createRouteBtn.addEventListener("click", createRoute);
    el.clearRouteBtn.addEventListener("click", clearRoute);
    el.newRouteBtn.addEventListener("click", newRoute);
    el.exportBtn.addEventListener("click", exportGPX);
    el.loadElevationBtn.addEventListener("click", loadElevation);

    el.mapType.addEventListener("change", () => {
      setTileLayer(el.mapType.value);
      setStatus("Estilo do mapa atualizado.");
    });

    el.themeSelect.addEventListener("change", () => {
      applyTheme(el.themeSelect.value);
    });

    el.routeType.addEventListener("change", () => {
      updateRouteLine();
      updateStats();
    });

    window.addEventListener("resize", () => {
      if (map) map.invalidateSize();

      if (validAltitudeValues()) {
        drawElevationChart();
      }
    });
  }

  /* -------------------- ARRANQUE -------------------- */

  function init() {
    if (!el.map || !el.elevationChart) {
      console.error(
        "Não foram encontrados os elementos essenciais do HTML."
      );
      return;
    }

    renderChartPlaceholder(
      "Cria um percurso e carrega a altimetria."
    );

    updateStats();
    applyTheme(el.themeSelect.value || "dark");

    initMap();

    if (!map) return;

    bindEvents();
    setStatus("Pronto para criar um percurso.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

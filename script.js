
/* ==========================================================
   GPX RUN STUDIO
   Ficheiro: script.js
   Lógica da aplicação, mapa, pesquisa, percursos,
   altimetria e GPX
   ========================================================== */

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    map: $("map"),
    mapHint: $("mapHint"),
    mapType: $("mapType"),
    routeType: $("routeType"),

    localitySearchInput: $("localitySearchInput"),
    localitySuggestions: $("localitySuggestions"),
    localitySearchStatus: $("localitySearchStatus"),

    createRouteBtn: $("createRouteBtn"),
    deletePointBtn: $("deletePointBtn"),
    undoBtn: $("undoBtn"),
    clearRouteBtn: $("clearRouteBtn"),
    newRouteBtn: $("newRouteBtn"),

    importGPXBtn: $("importGPXBtn"),
    importGPXInput: $("importGPXInput"),
    exportBtn: $("exportBtn"),

    loadElevationBtn: $("loadElevationBtn"),
    elevationChart: $("elevationChart"),
    chartDistance: $("chartDistance"),
    elevationStatus: $("elevationStatus"),

    distance: $("distance"),
    altitudeRange: $("altitudeRange"),
    ascent: $("ascent"),
    descent: $("descent"),
    pointCount: $("pointCount"),

    status: $("status"),
    themeSelect: $("themeSelect")
  };

  const DEFAULT_DISTANCE_KM = 5;
  const MAX_UNDO_STEPS = 40;
  const ELEVATION_BATCH_SIZE = 80;
  const LOCALITY_DEBOUNCE_MS = 700;
  const LOCALITY_MIN_REQUEST_INTERVAL_MS = 1000;
  const LOCALITY_CACHE_LIMIT = 50;

  const themeColors = {
    dark: "#ff7a18",
    light: "#e86b12",
    garmin: "#8bc34a",
    strava: "#fc4c02",
    midnight: "#a78bfa",
    forest: "#34d399",
    ocean: "#38bdf8",
    sunset: "#fb7185"
  };

  let map = null;
  let routeLine = null;
  let markers = [];
  let points = [];
  let altitudes = [];
  let selectedPointIndex = null;

  let undoHistory = [];
  let requestNumber = 0;

  let currentTheme = el.themeSelect?.value || "dark";
  let currentMapType = el.mapType?.value || "satellite";
  let lastRouteType = el.routeType?.value || "linear";

  const tileLayers = {};

  /* ==========================================================
     UTILITÁRIOS
     ========================================================== */

  function setStatus(message) {
    if (el.status) {
      el.status.textContent = message;
    }
  }

  function formatNumber(value, decimals = 2) {
    return Number(value).toLocaleString("pt-PT", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function clonePoints(source = points) {
    return source.map((point) => ({
      lat: Number(point.lat),
      lng: Number(point.lng)
    }));
  }

  function cloneAltitudes(source = altitudes) {
    return [...source];
  }

  function haversine(a, b) {
    const earthRadius = 6371000;
    const toRad = (value) => value * Math.PI / 180;

    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const deltaLat = toRad(b.lat - a.lat);
    const deltaLng = toRad(b.lng - a.lng);

    const value =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLng / 2) ** 2;

    const safeValue = Math.min(1, Math.max(0, value));

    return earthRadius * 2 *
      Math.atan2(
        Math.sqrt(safeValue),
        Math.sqrt(1 - safeValue)
      );
  }

  function calculateDistanceKm(source = points) {
    let metres = 0;

    for (let i = 1; i < source.length; i++) {
      metres += haversine(source[i - 1], source[i]);
    }

    return metres / 1000;
  }

  function invalidateElevationRequest() {
    requestNumber++;
  }

  function clearAltitudeData(updateInterface = true) {
    invalidateElevationRequest();
    altitudes = [];

    if (el.elevationStatus) {
      el.elevationStatus.textContent =
        points.length >= 2
          ? "Altimetria por carregar."
          : "À espera de um percurso.";
    }

    if (updateInterface) {
      updateStats();
      renderElevationChart();
      updateEditButtons();
    }
  }

  /* ==========================================================
     HISTÓRICO E VOLTAR ATRÁS
     ========================================================== */

  function saveUndoState(routeTypeOverride = null) {
    undoHistory.push({
      points: clonePoints(),
      altitudes: cloneAltitudes(),
      routeType: routeTypeOverride || el.routeType?.value || "linear",
      selectedPointIndex
    });

    if (undoHistory.length > MAX_UNDO_STEPS) {
      undoHistory.shift();
    }

    updateEditButtons();
  }

  function undoLastChange() {
    if (undoHistory.length === 0) {
      setStatus("Não existem alterações para recuperar.");
      return;
    }

    invalidateElevationRequest();

    const previous = undoHistory.pop();

    points = clonePoints(previous.points);
    altitudes = cloneAltitudes(previous.altitudes);

    if (el.routeType) {
      el.routeType.value = previous.routeType;
    }

    lastRouteType = previous.routeType;

    selectedPointIndex =
      Number.isInteger(previous.selectedPointIndex) &&
      previous.selectedPointIndex >= 0 &&
      previous.selectedPointIndex < points.length
        ? previous.selectedPointIndex
        : null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (points.length > 0) {
      fitRoute();
    }

    if (el.elevationStatus) {
      el.elevationStatus.textContent =
        altitudes.length === points.length &&
        altitudes.length > 0 &&
        altitudes.every(Number.isFinite)
          ? "Altimetria disponível."
          : points.length >= 2
            ? "Altimetria por carregar."
            : "À espera de um percurso.";
    }

    if (el.mapHint) {
      el.mapHint.textContent =
        "Alteração revertida. Podes continuar a editar o percurso.";
    }

    setStatus("Última alteração revertida.");
  }

  /* ==========================================================
     MAPA E CAMADAS
     ========================================================== */

  function initMap() {
    if (!el.map) {
      setStatus("Não foi encontrado o elemento do mapa no HTML.");
      return false;
    }

    if (typeof L === "undefined") {
      setStatus(
        "Não foi possível carregar o mapa. Verifica a ligação à Internet."
      );
      return false;
    }

    map = L.map(el.map, {
      zoomControl: true,
      doubleClickZoom: false
    }).setView([39.5, -8.0], 7);

    tileLayers.street = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19
      }
    );

    tileLayers.satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles &copy; Esri",
        maxZoom: 19
      }
    );

    tileLayers.terrain = L.tileLayer(
      "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      {
        attribution:
          "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
        maxZoom: 17
      }
    );

    setMapType(currentMapType);

    map.on("click", (event) => {
      addPoint({
        lat: event.latlng.lat,
        lng: event.latlng.lng
      });
    });

    return true;
  }

  function setMapType(type) {
    if (!map) return;

    if (!tileLayers[type]) {
      type = "satellite";
    }

    Object.values(tileLayers).forEach((layer) => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
    });

    tileLayers[type].addTo(map);
    currentMapType = type;

    if (el.mapType && el.mapType.value !== type) {
      el.mapType.value = type;
    }
  }

  /* ==========================================================
     MARCADORES E SELEÇÃO
     ========================================================== */

  function createPointIcon(index, selected = false) {
    const color = selected ? "#ef4444" : "#22c55e";

    return L.divIcon({
      className: "gpx-point-icon-wrapper",
      html: `
        <span
          class="gpx-point-marker ${selected ? "selected" : ""}"
          style="--point-color:${color}"
          title="${selected ? "Ponto selecionado" : `Ponto ${index + 1}`}"
        >${index + 1}</span>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
  }

  function selectPoint(index) {
    if (index < 0 || index >= points.length) return;

    selectedPointIndex = index;

    updateMarkers();
    updateEditButtons();

    if (el.mapHint) {
      el.mapHint.textContent =
        `Ponto ${index + 1} selecionado. Podes eliminá-lo ou arrastá-lo.`;
    }

    setStatus(`Ponto ${index + 1} selecionado.`);
  }

  function updateMarkers() {
    if (!map) return;

    markers.forEach((marker) => {
      map.removeLayer(marker);
    });

    markers = [];

    points.forEach((point, index) => {
      const marker = L.marker([point.lat, point.lng], {
        draggable: true,
        icon: createPointIcon(index, index === selectedPointIndex),
        riseOnHover: true,
        keyboard: true
      });

      marker.addTo(map);

      marker.on("click", () => {
        selectPoint(index);
      });

      marker.on("contextmenu", () => {
        removePoint(index);
      });

      marker.on("dragstart", () => {
        saveUndoState();
        selectedPointIndex = index;
      });

      marker.on("dragend", (event) => {
        const position = event.target.getLatLng();

        points[index] = {
          lat: position.lat,
          lng: position.lng
        };

        selectedPointIndex = index;

        clearAltitudeData(false);
        updateRouteLine();
        updateMarkers();
        updateStats();
        renderElevationChart();
        updateEditButtons();

        if (el.mapHint) {
          el.mapHint.textContent =
            `Ponto ${index + 1} reposicionado.`;
        }

        setStatus(`Ponto ${index + 1} reposicionado.`);
      });

      markers.push(marker);
    });
  }

  /* ==========================================================
     ADICIONAR, ELIMINAR E LIMPAR PONTOS
     ========================================================== */

  function addPoint(point) {
    if (
      !Number.isFinite(Number(point.lat)) ||
      !Number.isFinite(Number(point.lng))
    ) {
      setStatus("As coordenadas do ponto não são válidas.");
      return;
    }

    saveUndoState();

    points.push({
      lat: Number(point.lat),
      lng: Number(point.lng)
    });

    selectedPointIndex = points.length - 1;

    clearAltitudeData(false);
    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (el.mapHint) {
      el.mapHint.textContent =
        `Ponto ${points.length} adicionado. Continua a clicar no mapa.`;
    }

    setStatus(`Ponto ${points.length} adicionado ao percurso.`);
  }

  function removePoint(index) {
    if (index < 0 || index >= points.length) return;

    saveUndoState();

    points.splice(index, 1);
    selectedPointIndex = null;

    clearAltitudeData(false);
    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (el.mapHint) {
      el.mapHint.textContent =
        "Ponto eliminado. Clica no mapa para adicionar mais pontos.";
    }

    setStatus("Ponto eliminado.");
  }

  function deleteSelectedPoint() {
    if (
      selectedPointIndex === null ||
      selectedPointIndex < 0 ||
      selectedPointIndex >= points.length
    ) {
      setStatus("Seleciona primeiro um marcador no mapa.");
      return;
    }

    removePoint(selectedPointIndex);
  }

  function clearRoute() {
    if (points.length === 0) {
      setStatus("Não existem pontos para limpar.");
      return;
    }

    saveUndoState();
    invalidateElevationRequest();

    points = [];
    altitudes = [];
    selectedPointIndex = null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (el.elevationStatus) {
      el.elevationStatus.textContent = "À espera de um percurso.";
    }

    if (el.mapHint) {
      el.mapHint.textContent = "Clica no mapa para adicionar pontos.";
    }

    setStatus("Todos os pontos foram removidos.");
  }

  function newRoute() {
    if (points.length > 0 || altitudes.length > 0) {
      saveUndoState();
    }

    invalidateElevationRequest();

    points = [];
    altitudes = [];
    selectedPointIndex = null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (map) {
      map.setView([39.5, -8.0], 7);
    }

    if (el.elevationStatus) {
      el.elevationStatus.textContent = "À espera de um percurso.";
    }

    if (el.mapHint) {
      el.mapHint.textContent =
        "Novo percurso. Clica no mapa para começar.";
    }

    setStatus("Novo percurso iniciado.");
  }

  /* ==========================================================
     LINHA DO PERCURSO
     ========================================================== */

  function updateRouteLine() {
    if (!map) return;

    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }

    if (points.length >= 2) {
      routeLine = L.polyline(
        points.map((point) => [point.lat, point.lng]),
        {
          color: themeColors[currentTheme] || "#ff7a18",
          weight: 5,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round"
        }
      ).addTo(map);
    }
  }

  function fitRoute() {
    if (!map || points.length === 0) return;

    if (points.length === 1) {
      map.setView(
        [points[0].lat, points[0].lng],
        Math.max(map.getZoom(), 14)
      );
      return;
    }

    map.fitBounds(
      L.latLngBounds(
        points.map((point) => [point.lat, point.lng])
      ),
      {
        padding: [35, 35],
        maxZoom: 16
      }
    );
  }

  /* ==========================================================
     ESTATÍSTICAS
     ========================================================== */

  function resetAltitudeStats() {
    if (el.altitudeRange) el.altitudeRange.textContent = "— / — m";
    if (el.ascent) el.ascent.textContent = "— m";
    if (el.descent) el.descent.textContent = "— m";
  }

  function updateStats() {
    if (el.distance) {
      el.distance.textContent =
        `${formatNumber(calculateDistanceKm())} km`;
    }

    if (el.pointCount) {
      el.pointCount.textContent = String(points.length);
    }

    if (
      altitudes.length !== points.length ||
      altitudes.length === 0 ||
      !altitudes.every(Number.isFinite)
    ) {
      resetAltitudeStats();
      return;
    }

    const min = Math.min(...altitudes);
    const max = Math.max(...altitudes);

    if (el.altitudeRange) {
      el.altitudeRange.textContent =
        `${formatNumber(min, 0)} / ${formatNumber(max, 0)} m`;
    }

    let totalAscent = 0;
    let totalDescent = 0;

    for (let i = 1; i < altitudes.length; i++) {
      const difference = altitudes[i] - altitudes[i - 1];

      if (difference > 0) {
        totalAscent += difference;
      } else {
        totalDescent += Math.abs(difference);
      }
    }

    if (el.ascent) {
      el.ascent.textContent = `${formatNumber(totalAscent, 0)} m`;
    }

    if (el.descent) {
      el.descent.textContent = `${formatNumber(totalDescent, 0)} m`;
    }
  }

  function updateEditButtons() {
    if (el.deletePointBtn) {
      el.deletePointBtn.disabled =
        selectedPointIndex === null ||
        selectedPointIndex < 0 ||
        selectedPointIndex >= points.length;
    }

    if (el.undoBtn) {
      el.undoBtn.disabled = undoHistory.length === 0;
    }

    if (el.clearRouteBtn) {
      el.clearRouteBtn.disabled = points.length === 0;
    }

    if (el.exportBtn) {
      el.exportBtn.disabled = points.length < 2;
    }

    if (el.loadElevationBtn) {
      el.loadElevationBtn.disabled = points.length < 2;
    }
  }

  /* ==========================================================
     CRIAR PERCURSO AUTOMÁTICO
     ========================================================== */

  function createRoute() {
    if (!map) return;

    saveUndoState();

    const routeType = el.routeType?.value || "linear";
    const center = map.getCenter();
    const targetDistance = DEFAULT_DISTANCE_KM * 1000;
    const generated = [];

    const latitudeScale = 111320;
    const longitudeScale = Math.max(
      1000,
      111320 * Math.cos(center.lat * Math.PI / 180)
    );

    if (routeType === "circular") {
      const radius = targetDistance / (2 * Math.PI);
      const count = 40;

      for (let i = 0; i < count; i++) {
        const angle = 2 * Math.PI * i / count;

        generated.push({
          lat: center.lat +
            radius * Math.sin(angle) / latitudeScale,
          lng: center.lng +
            radius * Math.cos(angle) / longitudeScale
        });
      }

      generated.push({ ...generated[0] });
    } else {
      const northMetres = targetDistance / 2;
      const eastMetres = targetDistance / 2;

      generated.push({
        lat: center.lat - northMetres / latitudeScale,
        lng: center.lng - eastMetres / longitudeScale
      });

      generated.push({
        lat: center.lat + northMetres / latitudeScale,
        lng: center.lng + eastMetres / longitudeScale
      });
    }

    invalidateElevationRequest();

    points = generated;
    altitudes = [];
    selectedPointIndex = null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    fitRoute();
    updateEditButtons();

    if (el.elevationStatus) {
      el.elevationStatus.textContent = "Altimetria por carregar.";
    }

    if (el.mapHint) {
      el.mapHint.textContent =
        "Percurso criado. Podes selecionar, arrastar ou eliminar pontos.";
    }

    setStatus(
      `Percurso ${routeType === "circular" ? "circular" : "linear"} criado.`
    );
  }

  /* ==========================================================
     APARÊNCIA
     ========================================================== */

  function setTheme(theme) {
    currentTheme = Object.prototype.hasOwnProperty.call(themeColors, theme)
      ? theme
      : "dark";

    document.documentElement.dataset.theme = currentTheme;
    document.body.dataset.theme = currentTheme;

    if (el.themeSelect && el.themeSelect.value !== currentTheme) {
      el.themeSelect.value = currentTheme;
    }

    updateRouteLine();
    updateMarkers();
    renderElevationChart();
  }

  /* ==========================================================
     ALTIMETRIA — OPEN-METEO
     ========================================================== */

  async function loadElevation() {
    if (points.length < 2) {
      setStatus(
        "Adiciona pelo menos dois pontos antes de carregar a altimetria."
      );
      return;
    }

    const thisRequest = ++requestNumber;
    const locations = clonePoints();

    if (el.loadElevationBtn) {
      el.loadElevationBtn.disabled = true;
      el.loadElevationBtn.textContent = "A carregar…";
    }

    if (el.elevationStatus) {
      el.elevationStatus.textContent = "A carregar dados de elevação…";
    }

    if (el.elevationChart) {
      el.elevationChart.replaceChildren();

      const message = document.createElement("p");
      message.textContent = "A obter dados de altimetria…";
      el.elevationChart.appendChild(message);
    }

    try {
      const results = [];

      for (
        let i = 0;
        i < locations.length;
        i += ELEVATION_BATCH_SIZE
      ) {
        if (thisRequest !== requestNumber) return;

        const chunk = locations.slice(i, i + ELEVATION_BATCH_SIZE);

        const latitude = chunk
          .map((point) => point.lat)
          .join(",");

        const longitude = chunk
          .map((point) => point.lng)
          .join(",");

        const url =
          "https://api.open-meteo.com/v1/elevation" +
          `?latitude=${encodeURIComponent(latitude)}` +
          `&longitude=${encodeURIComponent(longitude)}`;

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(
            `O serviço de elevação respondeu com o estado ${response.status}.`
          );
        }

        const data = await response.json();

        if (
          !Array.isArray(data.elevation) ||
          data.elevation.length !== chunk.length
        ) {
          throw new Error("A resposta da altimetria não é válida.");
        }

        results.push(...data.elevation.map(Number));
      }

      if (thisRequest !== requestNumber) return;

      if (
        results.length !== points.length ||
        !results.every(Number.isFinite)
      ) {
        throw new Error(
          "Os dados recebidos não correspondem aos pontos do percurso."
        );
      }

      altitudes = results;

      if (el.elevationStatus) {
        el.elevationStatus.textContent = "Altimetria carregada.";
      }

      updateStats();
      renderElevationChart();

      setStatus("Altimetria carregada com sucesso.");
    } catch (error) {
      if (thisRequest !== requestNumber) return;

      console.error("Erro de altimetria:", error);

      if (el.elevationStatus) {
        el.elevationStatus.textContent =
          "Não foi possível carregar a altimetria.";
      }

      if (el.elevationChart) {
        el.elevationChart.replaceChildren();

        const message = document.createElement("p");
        message.textContent =
          "Não foi possível carregar a altimetria. Verifica a ligação à Internet e tenta novamente.";

        el.elevationChart.appendChild(message);
      }

      setStatus(
        "Erro ao carregar a altimetria. Podes tentar novamente."
      );
    } finally {
      if (thisRequest === requestNumber) {
        if (el.loadElevationBtn) {
          el.loadElevationBtn.textContent = "Carregar altimetria";
        }

        updateEditButtons();
      }
    }
  }

  function renderElevationChart() {
    if (!el.elevationChart) return;

    const totalDistance = calculateDistanceKm();

    if (el.chartDistance) {
      el.chartDistance.textContent = `${formatNumber(totalDistance)} km`;
    }

    if (points.length < 2) {
      el.elevationChart.innerHTML =
        "<p>Cria um percurso e carrega a altimetria.</p>";
      return;
    }

    if (
      altitudes.length !== points.length ||
      altitudes.length === 0 ||
      !altitudes.every(Number.isFinite)
    ) {
      el.elevationChart.innerHTML =
        "<p>Carrega a altimetria para visualizar o perfil de elevação.</p>";
      return;
    }

    const width = Math.max(
      Math.floor(el.elevationChart.clientWidth || 600),
      280
    );

    const height = 220;

    const padding = {
      top: 20,
      right: 18,
      bottom: 32,
      left: 48
    };

    const minAltitude = Math.min(...altitudes);
    const maxAltitude = Math.max(...altitudes);
    const range = Math.max(1, maxAltitude - minAltitude);

    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    const cumulativeDistances = [0];

    for (let i = 1; i < points.length; i++) {
      cumulativeDistances.push(
        cumulativeDistances[i - 1] +
        haversine(points[i - 1], points[i]) / 1000
      );
    }

    const profileDistance =
      cumulativeDistances[cumulativeDistances.length - 1];

    const coords = altitudes.map((altitude, index) => {
      const distanceFraction = profileDistance > 0
        ? cumulativeDistances[index] / profileDistance
        : index / Math.max(1, altitudes.length - 1);

      return {
        x: padding.left + distanceFraction * plotWidth,
        y: padding.top +
          ((maxAltitude - altitude) / range) * plotHeight
      };
    });

    const linePath = coords.map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    ).join(" ");

    const bottomY = height - padding.bottom;

    const areaPath =
      `${linePath} ` +
      `L ${coords[coords.length - 1].x} ${bottomY} ` +
      `L ${coords[0].x} ${bottomY} Z`;

    const color = themeColors[currentTheme] || "#ff7a18";
    const gradientId = "gpxElevationGradient";

    el.elevationChart.innerHTML = `
      <svg
        viewBox="0 0 ${width} ${height}"
        width="100%"
        role="img"
        aria-label="Gráfico de altimetria do percurso"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="${gradientId}"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stop-color="${color}" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>

        <line
          x1="${padding.left}"
          y1="${padding.top}"
          x2="${padding.left}"
          y2="${bottomY}"
          stroke="currentColor"
          stroke-opacity="0.18"
        />

        <line
          x1="${padding.left}"
          y1="${bottomY}"
          x2="${width - padding.right}"
          y2="${bottomY}"
          stroke="currentColor"
          stroke-opacity="0.18"
        />

        <path
          d="${areaPath}"
          fill="url(#${gradientId})"
        />

        <path
          d="${linePath}"
          fill="none"
          stroke="${color}"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <text
          x="${padding.left - 7}"
          y="${padding.top + 4}"
          text-anchor="end"
          font-size="10"
          fill="currentColor"
        >${Math.round(maxAltitude)} m</text>

        <text
          x="${padding.left - 7}"
          y="${bottomY}"
          text-anchor="end"
          font-size="10"
          fill="currentColor"
        >${Math.round(minAltitude)} m</text>

        <text
          x="${padding.left}"
          y="${height - 8}"
          font-size="10"
          fill="currentColor"
        >0 km</text>

        <text
          x="${width - padding.right}"
          y="${height - 8}"
          text-anchor="end"
          font-size="10"
          fill="currentColor"
        >${formatNumber(profileDistance)} km</text>
      </svg>
    `;
  }

  /* ==========================================================
     EXPORTAR GPX
     ========================================================== */

  function exportGPX() {
    if (points.length < 2) {
      setStatus("Adiciona pelo menos dois pontos para exportar um GPX.");
      return;
    }

    const trackPoints = points.map((point, index) => {
      const elevation = altitudes[index];

      const elevationTag = Number.isFinite(elevation)
        ? `<ele>${elevation.toFixed(1)}</ele>`
        : "";

      return (
        `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">` +
        `${elevationTag ? `\n        ${elevationTag}` : ""}` +
        "\n      </trkpt>"
      );
    }).join("\n");

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx
  version="1.1"
  creator="GPX Run Studio"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"
>
  <metadata>
    <name>GPX Run Studio</name>
  </metadata>
  <trk>
    <name>Meu percurso</name>
    <trkseg>
${trackPoints}
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

    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);

    setStatus("Ficheiro GPX exportado com sucesso.");
  }

  /* ==========================================================
     IMPORTAR GPX
     ========================================================== */

  function importGPX(gpxText) {
    const parser = new DOMParser();
    const documentGPX = parser.parseFromString(
      gpxText,
      "application/xml"
    );

    if (documentGPX.querySelector("parsererror")) {
      setStatus("O ficheiro GPX não tem um formato XML válido.");
      return false;
    }

    const trackPoints = Array.from(
      documentGPX.getElementsByTagNameNS("*", "trkpt")
    );

    const routePoints = Array.from(
      documentGPX.getElementsByTagNameNS("*", "rtept")
    );

    const wayPoints = Array.from(
      documentGPX.getElementsByTagNameNS("*", "wpt")
    );

    const sourcePoints = trackPoints.length > 0
      ? trackPoints
      : routePoints.length > 0
        ? routePoints
        : wayPoints;

    const importedPoints = [];
    const importedAltitudes = [];

    sourcePoints.forEach((node) => {
      const lat = Number(node.getAttribute("lat"));
      const lng = Number(node.getAttribute("lon"));

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        return;
      }

      importedPoints.push({ lat, lng });

      const elevationNode =
        node.getElementsByTagNameNS("*", "ele")[0];

      const elevation = elevationNode
        ? Number(elevationNode.textContent)
        : NaN;

      importedAltitudes.push(
        Number.isFinite(elevation) ? elevation : NaN
      );
    });

    if (importedPoints.length < 2) {
      setStatus(
        "O ficheiro GPX não contém pelo menos dois pontos válidos."
      );
      return false;
    }

    saveUndoState();
    invalidateElevationRequest();

    points = importedPoints;

    const hasCompleteAltitudes =
      importedAltitudes.length === importedPoints.length &&
      importedAltitudes.every(Number.isFinite);

    altitudes = hasCompleteAltitudes
      ? importedAltitudes
      : [];

    selectedPointIndex = null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    fitRoute();
    updateEditButtons();

    if (el.elevationStatus) {
      el.elevationStatus.textContent = hasCompleteAltitudes
        ? "Altitudes importadas do ficheiro GPX."
        : "Altimetria por carregar.";
    }

    if (el.mapHint) {
      el.mapHint.textContent =
        "GPX importado. Clica num marcador para selecionar um ponto.";
    }

    setStatus(
      `GPX importado com sucesso: ${points.length} pontos.`
    );

    return true;
  }

  async function handleGPXFileChange() {
    const file = el.importGPXInput?.files?.[0];

    if (!file) return;

    try {
      const text = await file.text();
      importGPX(text);
    } catch (error) {
      console.error("Erro ao ler GPX:", error);
      setStatus("Não foi possível ler o ficheiro GPX.");
    } finally {
      if (el.importGPXInput) {
        el.importGPXInput.value = "";
      }
    }
  }

  /* ==========================================================
     PESQUISA DE LOCALIDADES
     Serviço Photon — pesquisa geográfica OpenStreetMap
     A pesquisa apenas altera o centro e o zoom do mapa.
     ========================================================== */

  let localitySearchTimer = null;
  let localitySearchController = null;
  let localitySearchSequence = 0;
  let lastLocalityRequestTime = 0;

  const localitySearchCache = new Map();

  function setLocalitySearchStatus(message) {
    if (el.localitySearchStatus) {
      el.localitySearchStatus.textContent = message;
    }
  }

  function hideLocalitySuggestions() {
    if (!el.localitySuggestions) return;

    el.localitySuggestions.hidden = true;
    el.localitySuggestions.replaceChildren();

    el.localitySearchInput?.setAttribute("aria-expanded", "false");
  }

  function normalizeLocalityResult(item) {
    const properties = item.properties || {};
    const coordinates = item.geometry?.coordinates;

    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2
    ) {
      return null;
    }

    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }

    const name =
      properties.name ||
      properties.city ||
      properties.town ||
      properties.village ||
      properties.county ||
      properties.street;

    if (!name) return null;

    const detailParts = [
      properties.district,
      properties.county,
      properties.state,
      properties.country
    ].filter(Boolean);

    const detail = [...new Set(detailParts)]
      .filter((part) => part !== name)
      .join(", ");

    return {
      name,
      detail: detail || properties.type || "Localidade",
      lat,
      lng
    };
  }

  function showLocalitySuggestions(results) {
    const container = el.localitySuggestions;

    if (!container) return;

    container.replaceChildren();

    if (!results.length) {
      hideLocalitySuggestions();
      setLocalitySearchStatus("Não foram encontradas localidades.");
      return;
    }

    results.forEach((place, index) => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "locality-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.dataset.index = String(index);

      const title = document.createElement("strong");
      title.textContent = place.name;

      const detail = document.createElement("span");
      detail.textContent = place.detail;

      button.append(title, detail);

      button.addEventListener("click", () => {
        selectLocality(place);
      });

      container.appendChild(button);
    });

    container.hidden = false;

    el.localitySearchInput?.setAttribute("aria-expanded", "true");

    setLocalitySearchStatus(
      `${results.length} sugestões encontradas. Seleciona uma para centrar o mapa.`
    );
  }

  function selectLocality(place) {
    if (!map) return;

    const lat = Number(place.lat);
    const lng = Number(place.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      setLocalitySearchStatus(
        "As coordenadas desta localidade são inválidas."
      );
      hideLocalitySuggestions();
      return;
    }

    /*
     * Esta função só altera a vista do mapa.
     * Não altera os pontos, o percurso, as altitudes
     * nem o histórico de alterações.
     */

    map.setView([lat, lng], 13, {
      animate: true
    });

    if (el.localitySearchInput) {
      el.localitySearchInput.value = place.name;
    }

    hideLocalitySuggestions();

    setLocalitySearchStatus(
      `Mapa centrado em ${place.name}. O percurso não foi alterado.`
    );
  }

  async function searchLocalities(query) {
    const sequence = ++localitySearchSequence;

    if (localitySearchController) {
      localitySearchController.abort();
      localitySearchController = null;
    }

    const term = query.trim();

    if (term.length < 3) {
      hideLocalitySuggestions();

      setLocalitySearchStatus(
        term.length === 0
          ? ""
          : "Escreve pelo menos três caracteres."
      );

      return;
    }

    const cacheKey = term.toLocaleLowerCase("pt-PT");

    if (localitySearchCache.has(cacheKey)) {
      showLocalitySuggestions(localitySearchCache.get(cacheKey));
      return;
    }

    setLocalitySearchStatus("A procurar localidades…");

    /*
     * Limita a frequência dos pedidos ao serviço público.
     */

    const elapsed = Date.now() - lastLocalityRequestTime;

    const wait = Math.max(
      0,
      LOCALITY_MIN_REQUEST_INTERVAL_MS - elapsed
    );

    if (wait > 0) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, wait);
      });
    }

    if (sequence !== localitySearchSequence) return;

    const controller = new AbortController();
    localitySearchController = controller;

    try {
      const url = new URL("https://photon.komoot.io/api/");

      url.searchParams.set("q", term);
      url.searchParams.set("limit", "6");

      /*
       * CORREÇÃO:
       * O Photon rejeita lang=pt.
       * Usa-se "default", um dos valores aceites pela API.
       *
       * Isto não altera o idioma da interface da aplicação,
       * que continua em português de Portugal.
       */
      url.searchParams.set("lang", "default");

      lastLocalityRequestTime = Date.now();

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `O serviço de pesquisa respondeu com o estado ${response.status}.`
        );
      }

      const data = await response.json();

      if (sequence !== localitySearchSequence) return;

      /*
       * Algumas respostas da API podem conter informação de erro
       * mesmo quando o pedido HTTP foi aceite.
       */
      if (data && data.message && !Array.isArray(data.features)) {
        throw new Error(data.message);
      }

      const results = (Array.isArray(data.features) ? data.features : [])
        .map(normalizeLocalityResult)
        .filter(Boolean);

      localitySearchCache.set(cacheKey, results);

      if (localitySearchCache.size > LOCALITY_CACHE_LIMIT) {
        const oldestKey = localitySearchCache.keys().next().value;
        localitySearchCache.delete(oldestKey);
      }

      showLocalitySuggestions(results);
    } catch (error) {
      if (error.name === "AbortError") return;
      if (sequence !== localitySearchSequence) return;

      console.error("Erro na pesquisa de localidades:", error);

      hideLocalitySuggestions();

      let message =
        "Não foi possível pesquisar localidades. ";

      if (error instanceof TypeError) {
        message +=
          "O navegador não conseguiu aceder ao serviço. Verifica a ligação à Internet ou tenta novamente mais tarde.";
      } else {
        message +=
          `${error.message || "O serviço de pesquisa não respondeu como esperado."} Tenta novamente.`;
      }

      setLocalitySearchStatus(message);
    } finally {
      if (sequence === localitySearchSequence) {
        localitySearchController = null;
      }
    }
  }

  function bindLocalitySearchEvents() {
    const input = el.localitySearchInput;
    const suggestions = el.localitySuggestions;

    if (!input || !suggestions) return;

    input.addEventListener("input", () => {
      window.clearTimeout(localitySearchTimer);

      if (localitySearchController) {
        localitySearchController.abort();
        localitySearchController = null;
      }

      localitySearchSequence++;

      hideLocalitySuggestions();

      const term = input.value.trim();

      if (term.length < 3) {
        setLocalitySearchStatus(
          term.length === 0
            ? ""
            : "Escreve pelo menos três caracteres."
        );

        return;
      }

      setLocalitySearchStatus("A aguardar pesquisa…");

      localitySearchTimer = window.setTimeout(() => {
        searchLocalities(input.value);
      }, LOCALITY_DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (event) => {
      const options = Array.from(
        suggestions.querySelectorAll(".locality-suggestion")
      );

      if (event.key === "ArrowDown" && !suggestions.hidden) {
        event.preventDefault();
        options[0]?.focus();
      } else if (
        event.key === "Escape" &&
        !suggestions.hidden
      ) {
        event.preventDefault();
        hideLocalitySuggestions();
      } else if (
        event.key === "Enter" &&
        !suggestions.hidden &&
        options.length
      ) {
        event.preventDefault();
        options[0].click();
      }
    });

    suggestions.addEventListener("keydown", (event) => {
      const options = Array.from(
        suggestions.querySelectorAll(".locality-suggestion")
      );

      const activeIndex = options.indexOf(document.activeElement);

      if (event.key === "ArrowDown") {
        event.preventDefault();

        const nextIndex = Math.min(
          activeIndex + 1,
          options.length - 1
        );

        options[nextIndex]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();

        if (activeIndex <= 0) {
          input.focus();
        } else {
          options[activeIndex - 1]?.focus();
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        hideLocalitySuggestions();
        input.focus();
      }
    });

    document.addEventListener("click", (event) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".locality-search")
      ) {
        hideLocalitySuggestions();
      }
    });
  }

  /* ==========================================================
     EVENTOS
     ========================================================== */

  function bindEvents() {
    el.createRouteBtn?.addEventListener("click", createRoute);

    el.deletePointBtn?.addEventListener(
      "click",
      deleteSelectedPoint
    );

    el.undoBtn?.addEventListener("click", undoLastChange);

    el.clearRouteBtn?.addEventListener("click", clearRoute);

    el.newRouteBtn?.addEventListener("click", newRoute);

    el.importGPXBtn?.addEventListener("click", () => {
      el.importGPXInput?.click();
    });

    el.importGPXInput?.addEventListener(
      "change",
      handleGPXFileChange
    );

    el.exportBtn?.addEventListener("click", exportGPX);

    el.loadElevationBtn?.addEventListener(
      "click",
      loadElevation
    );

    el.mapType?.addEventListener("change", () => {
      setMapType(el.mapType.value);
      setStatus("Estilo do mapa atualizado.");
    });

    el.themeSelect?.addEventListener("change", () => {
      setTheme(el.themeSelect.value);
      setStatus("Tema visual atualizado.");
    });

    el.routeType?.addEventListener("change", () => {
      const newRouteType = el.routeType.value;

      if (newRouteType !== lastRouteType) {
        saveUndoState(lastRouteType);
        lastRouteType = newRouteType;
      }

      setStatus("Tipo de percurso atualizado.");
    });

    window.addEventListener("resize", () => {
      if (map) {
        map.invalidateSize();
      }

      renderElevationChart();
    });

    if ("ResizeObserver" in window && el.elevationChart) {
      const chartObserver = new ResizeObserver(() => {
        renderElevationChart();
      });

      chartObserver.observe(el.elevationChart);
    }

    bindLocalitySearchEvents();
  }

  /* ==========================================================
     INICIALIZAÇÃO
     ========================================================== */

  function init() {
    if (!initMap()) return;

    lastRouteType = el.routeType?.value || "linear";

    bindEvents();

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();
    setTheme(currentTheme);
    setMapType(currentMapType);

    if (el.mapHint) {
      el.mapHint.textContent =
        "Clica no mapa para adicionar pontos. Clica num marcador para o selecionar.";
    }

    if (el.elevationStatus) {
      el.elevationStatus.textContent = "À espera de um percurso.";
    }

    setStatus("GPX Run Studio pronto para criar um percurso.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

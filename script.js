/* ==========================================================
   GPX RUN STUDIO
   Percursos, pesquisa de localidades, pontos, altimetria e GPX
   ========================================================== */

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    map: $("map"),
    mapHint: $("mapHint"),
    mapType: $("mapType"),
    routeType: $("routeType"),
    createRouteBtn: $("createRouteBtn"),
    deletePointBtn: $("deletePointBtn"),
    undoBtn: $("undoBtn"),
    clearRouteBtn: $("clearRouteBtn"),
    newRouteBtn: $("newRouteBtn"),
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

  let map = null;
  let routeLine = null;
  let markers = [];
  let points = [];
  let altitudes = [];
  let selectedPointIndex = null;

  let undoHistory = [];
  let lastRouteType = el.routeType?.value || "linear";
  let requestNumber = 0;
  let currentTheme = el.themeSelect?.value || "dark";
  let currentMapType = el.mapType?.value || "satellite";

  const tileLayers = {};

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

  /* ----------------------------------------------------------
     UTILITÁRIOS
     ---------------------------------------------------------- */

  function setStatus(message) {
    if (el.status) el.status.textContent = message;
  }

  function formatNumber(value, decimals = 2) {
    return Number(value).toLocaleString("pt-PT", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function clonePoints(source = points) {
    return source.map((point) => ({
      lat: Number(point.lat),
      lng: Number(point.lng)
    }));
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

    return earthRadius * 2 *
      Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function calculateDistanceKm(source = points) {
    let metres = 0;

    for (let i = 1; i < source.length; i++) {
      metres += haversine(source[i - 1], source[i]);
    }

    return metres / 1000;
  }

  /* ----------------------------------------------------------
     PESQUISA DE LOCALIDADES
     ---------------------------------------------------------- */

  let searchTimer = null;
  let searchController = null;
  let searchResults = [];
  let activeSuggestionIndex = -1;
  let lastSearchTime = 0;

  let locationSearchInput = null;
  let locationSuggestions = null;
  let locationSearchMessage = null;

  function addSearchStyles() {
    if ($("locationSearchStyles")) return;

    const style = document.createElement("style");
    style.id = "locationSearchStyles";

    style.textContent = `
      .location-search {
        position: relative;
        z-index: 1000;
        padding: 14px 18px;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }

      .location-search-label {
        display: block;
        margin: 0 0 7px;
        color: var(--text);
        font-size: 12px;
        font-weight: 750;
      }

      .location-search-input-wrap {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .location-search-input {
        display: block;
        width: 100%;
        min-width: 0;
        height: 44px;
        padding: 10px 13px;
        border: 1px solid var(--border);
        border-radius: 8px;
        outline: none;
        background: var(--surface-2);
        color: var(--text);
        font: inherit;
        font-size: 13px;
        transition: border-color .18s ease, box-shadow .18s ease;
      }

      .location-search-input::placeholder {
        color: var(--muted);
        opacity: 1;
      }

      .location-search-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }

      .location-search-clear {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-2);
        color: var(--text);
        font-size: 19px;
        cursor: pointer;
      }

      .location-search-clear:hover {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .location-search-message {
        margin-top: 6px;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.5;
      }

      .location-suggestions {
        position: absolute;
        top: calc(100% + 5px);
        left: 0;
        right: 48px;
        z-index: 2000;
        display: none;
        max-height: 300px;
        overflow-y: auto;
        padding: 5px;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: var(--surface);
        box-shadow: 0 12px 30px rgba(0, 0, 0, .28);
      }

      .location-suggestions.visible {
        display: block;
      }

      .location-suggestion {
        display: block;
        width: 100%;
        padding: 10px 11px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        text-align: left;
        font: inherit;
        cursor: pointer;
      }

      .location-suggestion:hover,
      .location-suggestion.active {
        background: var(--accent-soft);
      }

      .location-suggestion strong {
        display: block;
        margin-bottom: 2px;
        font-size: 12px;
        font-weight: 750;
      }

      .location-suggestion span {
        display: block;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.5;
      }

      .location-search-attribution {
        margin-top: 5px;
        color: var(--muted);
        font-size: 10px;
      }

      .location-search-attribution a {
        color: var(--muted);
        text-decoration: underline;
      }

      @media (max-width: 560px) {
        .location-search {
          padding: 12px;
        }

        .location-suggestions {
          right: 48px;
          max-height: 240px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function createLocationSearch() {
    if (!el.map || $("locationSearchPanel")) return;

    addSearchStyles();

    const panel = document.createElement("section");
    panel.id = "locationSearchPanel";
    panel.className = "location-search";
    panel.setAttribute("aria-label", "Pesquisar localidade");

    panel.innerHTML = `
      <label class="location-search-label" for="locationSearchInput">
        Pesquisar localidade
      </label>

      <div class="location-search-input-wrap">
        <input
          id="locationSearchInput"
          class="location-search-input"
          type="text"
          placeholder="Escreve uma localidade, por exemplo Coimbra..."
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
          aria-controls="locationSearchSuggestions"
          aria-expanded="false"
          role="combobox"
        />

        <button
          id="locationSearchClear"
          class="location-search-clear"
          type="button"
          aria-label="Limpar pesquisa"
          title="Limpar pesquisa"
        >×</button>

        <div
          id="locationSearchSuggestions"
          class="location-suggestions"
          role="listbox"
        ></div>
      </div>

      <div
        id="locationSearchMessage"
        class="location-search-message"
        aria-live="polite"
      >Escreve pelo menos 3 letras para procurar uma localidade.</div>

      <div class="location-search-attribution">
        Pesquisa fornecida por
        <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>.
      </div>
    `;

    el.map.parentNode.insertBefore(panel, el.map);

    locationSearchInput = $("locationSearchInput");
    locationSuggestions = $("locationSearchSuggestions");
    locationSearchMessage = $("locationSearchMessage");

    locationSearchInput.addEventListener("input", onLocationSearchInput);
    locationSearchInput.addEventListener("keydown", onLocationSearchKeydown);

    $("locationSearchClear").addEventListener("click", () => {
      clearLocationSearch();
      locationSearchInput.focus();
    });

    document.addEventListener("click", (event) => {
      if (!panel.contains(event.target)) {
        hideLocationSuggestions();
      }
    });
  }

  function onLocationSearchInput() {
    const query = locationSearchInput.value.trim();

    clearTimeout(searchTimer);
    hideLocationSuggestions();
    activeSuggestionIndex = -1;
    searchResults = [];

    if (searchController) {
      searchController.abort();
      searchController = null;
    }

    if (query.length < 3) {
      setLocationSearchMessage(
        "Escreve pelo menos 3 letras para procurar uma localidade."
      );
      return;
    }

    setLocationSearchMessage("A preparar a pesquisa…");

    // Evita enviar um pedido por cada letra escrita.
    searchTimer = setTimeout(() => {
      searchLocations(query);
    }, 800);
  }

  async function searchLocations(query) {
    if (!locationSearchInput || query !== locationSearchInput.value.trim()) {
      return;
    }

    if (searchController) searchController.abort();

    searchController = new AbortController();

    // Respeita um intervalo entre pedidos ao serviço de pesquisa.
    const elapsed = Date.now() - lastSearchTime;
    const wait = Math.max(0, 1000 - elapsed);

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    if (
      !locationSearchInput ||
      query !== locationSearchInput.value.trim()
    ) {
      return;
    }

    const controller = searchController;

    try {
      setLocationSearchMessage("A procurar localidades…");

      const url =
        "https://nominatim.openstreetmap.org/search" +
        "?format=jsonv2" +
        "&addressdetails=1" +
        "&countrycodes=pt" +
        "&limit=7" +
        "&accept-language=pt" +
        &q=${encodeURIComponent(query)};

      lastSearchTime = Date.now();

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error("O serviço de pesquisa não respondeu.");
      }

      const results = await response.json();

      if (
        controller !== searchController ||
        query !== locationSearchInput.value.trim()
      ) {
        return;
      }

      searchResults = Array.isArray(results)
        ? results.filter((item) =>
            Number.isFinite(Number(item.lat)) &&
            Number.isFinite(Number(item.lon))
          )
        : [];

      if (searchResults.length === 0) {
        hideLocationSuggestions();
        setLocationSearchMessage(
          "Não foram encontradas localidades. Experimenta escrever outro nome."
        );
        return;
      }

      renderLocationSuggestions(searchResults);

      setLocationSearchMessage(
        ${searchResults.length} sugestões encontradas. Seleciona uma para centrar o mapa.
      );
    } catch (error) {
      if (error.name === "AbortError") return;

      console.error("Erro na pesquisa de localidades:", error);

      hideLocationSuggestions();

      setLocationSearchMessage(
        "Não foi possível pesquisar. Verifica a ligação à Internet e tenta novamente."
      );
    }
  }

  function getLocationTitle(item) {
    const address = item.address || {};

    return (
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      item.name ||
      item.display_name?.split(",")[0] ||
      "Localidade"
    );
  }

  function getLocationSubtitle(item) {
    const address = item.address || {};

    const parts = [
      address.suburb,
      address.city_district,
      address.municipality,
      address.county,
      address.state
    ].filter(Boolean);

    const uniqueParts = [...new Set(parts)];
    const title = getLocationTitle(item);

    const filtered = uniqueParts.filter((part) => part !== title);

    if (filtered.length > 0) {
      return filtered.slice(0, 3).join(", ");
    }

    return item.display_name || "Portugal";
  }

  function renderLocationSuggestions(results) {
    if (!locationSuggestions) return;

    locationSuggestions.replaceChildren();

    results.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "location-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");

      const title = document.createElement("strong");
      title.textContent = getLocationTitle(item);

      const subtitle = document.createElement("span");
      subtitle.textContent = getLocationSubtitle(item);

      button.append(title, subtitle);

      button.addEventListener("click", () => {
        selectLocation(item);
      });

      button.addEventListener("mouseenter", () => {
        setActiveSuggestion(index);
      });

      locationSuggestions.appendChild(button);
    });

    locationSuggestions.classList.add("visible");
    locationSearchInput.setAttribute("aria-expanded", "true");
  }

  function setActiveSuggestion(index) {
    if (!locationSuggestions) return;

    const buttons = Array.from(
      locationSuggestions.querySelectorAll(".location-suggestion")
    );

    if (buttons.length === 0) return;

    activeSuggestionIndex = Math.max(
      0,
      Math.min(index, buttons.length - 1)
    );

    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === activeSuggestionIndex;

      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    buttons[activeSuggestionIndex].scrollIntoView({
      block: "nearest"
    });
  }

  function onLocationSearchKeydown(event) {
    if (!locationSuggestions?.classList.contains("visible")) {
      if (event.key === "Escape") hideLocationSuggestions();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(activeSuggestionIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(
        activeSuggestionIndex <= 0
          ? searchResults.length - 1
          : activeSuggestionIndex - 1
      );
    } else if (event.key === "Enter") {
      event.preventDefault();

      if (
        activeSuggestionIndex >= 0 &&
        searchResults[activeSuggestionIndex]
      ) {
        selectLocation(searchResults[activeSuggestionIndex]);
      } else if (searchResults.length === 1) {
        selectLocation(searchResults[0]);
      }
    } else if (event.key === "Escape") {
      hideLocationSuggestions();
    }
  }

  function selectLocation(item) {
    if (!map) return;

    const lat = Number(item.lat);
    const lng = Number(item.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setLocationSearchMessage("Não foi possível localizar este resultado.");
      return;
    }

    const title = getLocationTitle(item);
    const subtitle = getLocationSubtitle(item);

    // Mover o mapa não altera nem apaga os pontos do percurso.
    map.setView([lat, lng], 14, {
      animate: true
    });

    locationSearchInput.value = title;
    hideLocationSuggestions();

    setLocationSearchMessage(
      Mapa centrado em ${title}${subtitle ?  — ${subtitle} : ""}.
    );

    setStatus(
      Mapa centrado em ${title}. Os pontos do percurso foram preservados.
    );

    if (el.mapHint) {
      el.mapHint.textContent =
        Localização: ${title}. Clica no mapa para adicionar pontos ao percurso.;
    }

    // Atualiza o tamanho do mapa sem mexer nos pontos existentes.
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 150);
  }

  function setLocationSearchMessage(message) {
    if (locationSearchMessage) {
      locationSearchMessage.textContent = message;
    }
  }

  function hideLocationSuggestions() {
    if (!locationSuggestions) return;

    locationSuggestions.classList.remove("visible");
    locationSearchInput?.setAttribute("aria-expanded", "false");
  }

  function clearLocationSearch() {
    clearTimeout(searchTimer);

    if (searchController) {
      searchController.abort();
      searchController = null;
    }

    if (locationSearchInput) locationSearchInput.value = "";

    searchResults = [];
    activeSuggestionIndex = -1;

    hideLocationSuggestions();

    setLocationSearchMessage(
      "Escreve pelo menos 3 letras para procurar uma localidade."
    );
  }

  /* ----------------------------------------------------------
     HISTÓRICO — VOLTAR ATRÁS
     ---------------------------------------------------------- */

  function saveUndoState(routeTypeOverride = null) {
    undoHistory.push({
      points: clonePoints(),
      altitudes: [...altitudes],
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

    const previous = undoHistory.pop();

    requestNumber++;

    points = clonePoints(previous.points);
    altitudes = [...previous.altitudes];

    if (el.routeType) el.routeType.value = previous.routeType;

    lastRouteType = previous.routeType;

    selectedPointIndex =
      previous.selectedPointIndex !== null &&
      previous.selectedPointIndex >= 0 &&
      previous.selectedPointIndex < points.length
        ? previous.selectedPointIndex
        : null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (points.length > 0) fitRoute();

    if (el.elevationStatus) {
      el.elevationStatus.textContent =
        altitudes.length === points.length && altitudes.length > 0
          ? "Altimetria disponível."
          : points.length >= 2
            ? "Altimetria por carregar."
            : "À espera de um percurso.";
    }

    if (el.mapHint) {
      el.mapHint.textContent =
        "Alteração revertida. Clica no mapa para adicionar pontos.";
    }

    setStatus("Última alteração revertida.");
  }

  /* ----------------------------------------------------------
     MAPA
     ---------------------------------------------------------- */

  function initMap() {
    if (!el.map || typeof L === "undefined") {
      setStatus("Não foi possível carregar o mapa. Verifica a ligação à Internet.");
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
        attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
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

    if (!tileLayers[type]) type = "satellite";

    Object.values(tileLayers).forEach((layer) => {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    });

    tileLayers[type].addTo(map);
    currentMapType = type;
  }

  /* ----------------------------------------------------------
     MARCADORES E SELEÇÃO
     ---------------------------------------------------------- */

  function createPointIcon(index, selected = false) {
    const color = selected ? "#ef4444" : "#22c55e";

    return L.divIcon({
      className: "gpx-point-icon-wrapper",
      html: `
        <span
          class="gpx-point-marker ${selected ? "selected" : ""}"
          style="--point-color:${color}"
          title="${selected ? "Ponto selecionado" : "Ponto " + (index + 1)}"
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
        Ponto ${index + 1} selecionado. Podes eliminá-lo ou arrastá-lo.;
    }

    setStatus(Ponto ${index + 1} selecionado.);
  }

  function updateMarkers() {
    if (!map) return;

    markers.forEach((marker) => map.removeLayer(marker));
    markers = [];

    points.forEach((point, index) => {
      const marker = L.marker([point.lat, point.lng], {
        draggable: true,
        icon: createPointIcon(index, index === selectedPointIndex),
        riseOnHover: true,
        keyboard: true
      });

      marker.addTo(map);

      marker.on("click", () => selectPoint(index));
      marker.on("contextmenu", () => removePoint(index));

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

        updateRouteLine();
        updateMarkers();
        updateStats();
        updateEditButtons();

        setStatus(Ponto ${index + 1} reposicionado.);
      });

      markers.push(marker);
    });
  }

  /* ----------------------------------------------------------
     PONTOS: ADICIONAR, ELIMINAR, LIMPAR
     ---------------------------------------------------------- */

  function addPoint(point) {
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
    updateEditButtons();

    if (el.mapHint) {
      el.mapHint.textContent =
        Ponto ${points.length} adicionado. Clica num marcador para o selecionar.;
    }

    setStatus(Ponto ${points.length} adicionado ao percurso.);
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
      setStatus("Clica primeiro num marcador para selecionar o ponto.");
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

    requestNumber++;
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
    if (points.length > 0 || altitudes.length > 0) saveUndoState();

    requestNumber++;
    points = [];
    altitudes = [];
    selectedPointIndex = null;

    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();

    if (map) map.setView([39.5, -8.0], 7);

    if (el.elevationStatus) {
      el.elevationStatus.textContent = "À espera de um percurso.";
    }

    if (el.mapHint) {
      el.mapHint.textContent = "Novo percurso. Clica no mapa para começar.";
    }

    setStatus("Novo percurso iniciado.");
  }

  /* ----------------------------------------------------------
     LINHA DO PERCURSO E ESTATÍSTICAS
     ---------------------------------------------------------- */

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
      L.latLngBounds(points.map((point) => [point.lat, point.lng])),
      {
        padding: [35, 35],
        maxZoom: 16
      }
    );
  }

  function updateStats() {
    if (el.distance) {
      el.distance.textContent = ${formatNumber(calculateDistanceKm())} km;
    }

    if (el.pointCount) el.pointCount.textContent = String(points.length);

    if (altitudes.length !== points.length || altitudes.length === 0) {
      if (el.altitudeRange) el.altitudeRange.textContent = "— / — m";
      if (el.ascent) el.ascent.textContent = "— m";
      if (el.descent) el.descent.textContent = "— m";
      return;
    }

    const validAltitudes = altitudes.filter(Number.isFinite);

    if (validAltitudes.length === 0) {
      if (el.altitudeRange) el.altitudeRange.textContent = "— / — m";
      if (el.ascent) el.ascent.textContent = "— m";
      if (el.descent) el.descent.textContent = "— m";
      return;
    }

    const min = Math.min(...validAltitudes);
    const max = Math.max(...validAltitudes);

    if (el.altitudeRange) {
      el.altitudeRange.textContent =
        ${formatNumber(min, 0)} / ${formatNumber(max, 0)} m;
    }

    let totalAscent = 0;
    let totalDescent = 0;

    for (let i = 1; i < altitudes.length; i++) {
      if (
        !Number.isFinite(altitudes[i - 1]) ||
        !Number.isFinite(altitudes[i])
      ) continue;

      const difference = altitudes[i] - altitudes[i - 1];

      if (difference > 0) totalAscent += difference;
      else totalDescent += Math.abs(difference);
    }

    if (el.ascent) el.ascent.textContent = ${formatNumber(totalAscent, 0)} m;
    if (el.descent) el.descent.textContent = ${formatNumber(totalDescent, 0)} m;
  }

  function updateEditButtons() {
    if (el.deletePointBtn) {
      el.deletePointBtn.disabled =
        selectedPointIndex === null ||
        selectedPointIndex < 0 ||
        selectedPointIndex >= points.length;
    }

    if (el.undoBtn) el.undoBtn.disabled = undoHistory.length === 0;
    if (el.clearRouteBtn) el.clearRouteBtn.disabled = points.length === 0;
    if (el.exportBtn) el.exportBtn.disabled = points.length < 2;
    if (el.loadElevationBtn) el.loadElevationBtn.disabled = points.length < 2;
  }

  /* ----------------------------------------------------------
     CRIAR PERCURSO AUTOMÁTICO
     ---------------------------------------------------------- */

  function createRoute() {
    if (!map) return;

    saveUndoState();

    const routeType = el.routeType?.value || "linear";
    const center = map.getCenter();
    const targetDistance = DEFAULT_DISTANCE_KM * 1000;
    const generated = [];

    if (routeType === "circular") {
      const radius = targetDistance / (2 * Math.PI);
      const latitudeScale = 111320;
      const longitudeScale = Math.max(
        1000,
        111320 * Math.cos(center.lat * Math.PI / 180)
      );

      const count = 40;

      for (let i = 0; i < count; i++) {
        const angle = 2 * Math.PI * i / count;

        generated.push({
          lat: center.lat + radius * Math.sin(angle) / latitudeScale,
          lng: center.lng + radius * Math.cos(angle) / longitudeScale
        });
      }

      generated.push({ ...generated[0] });
    } else {
      const latitudeScale = 111320;
      const longitudeScale = Math.max(
        1000,
        111320 * Math.cos(center.lat * Math.PI / 180)
      );

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

    requestNumber++;
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
      Percurso ${routeType === "circular" ? "circular" : "linear"} criado.
    );
  }

  /* ----------------------------------------------------------
     APARÊNCIA
     ---------------------------------------------------------- */

  function setTheme(theme) {
    currentTheme = themeColors[theme] ? theme : "dark";

    document.documentElement.dataset.theme = currentTheme;
    document.body.dataset.theme = currentTheme;

    updateRouteLine();
    updateMarkers();
    renderElevationChart();
  }

  /* ----------------------------------------------------------
     ALTIMETRIA — OPEN-METEO
     ---------------------------------------------------------- */

  function clearAltitudeData(render = true) {
    requestNumber++;
    altitudes = [];

    if (el.elevationStatus) {
      el.elevationStatus.textContent =
        points.length >= 2
          ? "Altimetria por carregar."
          : "À espera de um percurso.";
    }

    if (render) {
      updateStats();
      renderElevationChart();
    }
  }

  async function loadElevation() {
    if (points.length < 2) {
      setStatus("Adiciona pelo menos dois pontos antes de carregar a altimetria.");
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
      el.elevationChart.innerHTML = "<p>A obter dados de altimetria…</p>";
    }

    try {
      const results = [];

      for (let i = 0; i < locations.length; i += 100) {
        if (thisRequest !== requestNumber) return;

        const chunk = locations.slice(i, i + 100);
        const latitude = chunk.map((point) => point.lat).join(",");
        const longitude = chunk.map((point) => point.lng).join(",");

        const url =
          "https://api.open-meteo.com/v1/elevation" +
          ?latitude=${encodeURIComponent(latitude)} +
          &longitude=${encodeURIComponent(longitude)};

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error("Não foi possível obter os dados de elevação.");
        }

        const data = await response.json();

        if (!Array.isArray(data.elevation)) {
          throw new Error("A resposta da altimetria não é válida.");
        }

        results.push(...data.elevation.map(Number));
      }

      if (thisRequest !== requestNumber) return;

      if (results.length !== points.length) {
        throw new Error("Os dados recebidos não correspondem aos pontos.");
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
        el.elevationStatus.textContent = "Não foi possível carregar a altimetria.";
      }

      if (el.elevationChart) {
        el.elevationChart.innerHTML =
          "<p>Não foi possível carregar a altimetria. Verifica a ligação à Internet e tenta novamente.</p>";
      }

      setStatus("Erro ao carregar a altimetria.");
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
      el.chartDistance.textContent = ${formatNumber(totalDistance)} km;
    }

    if (points.length < 2) {
      el.elevationChart.innerHTML =
        "<p>Cria um percurso e carrega a altimetria.</p>";
      return;
    }

    if (altitudes.length !== points.length) {
      el.elevationChart.innerHTML =
        "<p>Carrega a altimetria para visualizar o perfil de elevação.</p>";
      return;
    }

    const values = altitudes.filter(Number.isFinite);

    if (values.length < 2) {
      el.elevationChart.innerHTML =
        "<p>Não existem dados de elevação suficientes para desenhar o perfil.</p>";
      return;
    }

    const width = Math.max(el.elevationChart.clientWidth || 600, 280);
    const height = 220;

    const padding = {
      top: 18,
      right: 16,
      bottom: 30,
      left: 45
    };

    const minAltitude = Math.min(...values);
    const maxAltitude = Math.max(...values);
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
      ${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}
    ).join(" ");

    const bottomY = height - padding.bottom;

    const areaPath =
      ${linePath}  +
      L ${coords[coords.length - 1].x} ${bottomY}  +
      L ${coords[0].x} ${bottomY} Z;

    const color = themeColors[currentTheme] || "#ff7a18";

    el.elevationChart.innerHTML = `
      <svg
        viewBox="0 0 ${width} ${height}"
        width="100%"
        role="img"
        aria-label="Gráfico de altimetria do percurso"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="elevationGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>

        <line x1="${padding.left}" y1="${padding.top}"
          x2="${padding.left}" y2="${bottomY}"
          stroke="currentColor" stroke-opacity="0.18"/>

        <line x1="${padding.left}" y1="${bottomY}"
          x2="${width - padding.right}" y2="${bottomY}"
          stroke="currentColor" stroke-opacity="0.18"/>

        <path d="${areaPath}" fill="url(#elevationGradient)"/>

        <path d="${linePath}" fill="none" stroke="${color}"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>

        <text x="${padding.left - 7}" y="${padding.top + 4}"
          text-anchor="end" font-size="10" fill="currentColor">${Math.round(maxAltitude)} m</text>

        <text x="${padding.left - 7}" y="${bottomY}"
          text-anchor="end" font-size="10" fill="currentColor">${Math.round(minAltitude)} m</text>

        <text x="${padding.left}" y="${height - 7}"
          font-size="10" fill="currentColor">0 km</text>

        <text x="${width - padding.right}" y="${height - 7}"
          text-anchor="end" font-size="10" fill="currentColor">${formatNumber(profileDistance)} km</text>
      </svg>
    `;
  }

  /* ----------------------------------------------------------
     EXPORTAR GPX
     ---------------------------------------------------------- */

  function exportGPX() {
    if (points.length < 2) {
      setStatus("Adiciona pelo menos dois pontos para exportar um GPX.");
      return;
    }

    const trackPoints = points.map((point, index) => {
      const elevation = altitudes[index];

      const elevationTag = Number.isFinite(elevation)
        ? <ele>${elevation.toFixed(1)}</ele>
        : "";

      return `
      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">
        ${elevationTag}
      </trkpt>`;
    }).join("");

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

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus("Ficheiro GPX exportado.");
  }

  /* ----------------------------------------------------------
     IMPORTAR GPX
     ---------------------------------------------------------- */

  function ensureImportInput() {
    let input = $("importGPXInput");

    if (input) return input;

    input = document.createElement("input");
    input.id = "importGPXInput";
    input.type = "file";
    input.accept = ".gpx,application/gpx+xml,application/xml,text/xml";
    input.hidden = true;

    document.body.appendChild(input);

    input.addEventListener("change", async () => {
      const file = input.files?.[0];

      if (!file) return;

      try {
        const text = await file.text();
        importGPX(text);
      } catch (error) {
        console.error(error);
        setStatus("Não foi possível ler o ficheiro GPX.");
      } finally {
        input.value = "";
      }
    });

    return input;
  }

  function importGPX(gpxText) {
    const parser = new DOMParser();
    const documentGPX = parser.parseFromString(
      gpxText,
      "application/xml"
    );

    if (documentGPX.querySelector("parsererror")) {
      setStatus("O ficheiro GPX não tem um formato válido.");
      return;
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

    const sourcePoints = trackPoints.length
      ? trackPoints
      : routePoints.length
        ? routePoints
        : wayPoints;

    const importedPoints = [];
    const importedAltitudes = [];

    sourcePoints.forEach((node) => {
      const lat = Number(node.getAttribute("lat"));
      const lng = Number(node.getAttribute("lon"));

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

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
      setStatus("O ficheiro GPX não contém pontos suficientes.");
      return;
    }

    saveUndoState();

    requestNumber++;
    points = importedPoints;

    altitudes = importedAltitudes.some(Number.isFinite)
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
      el.elevationStatus.textContent = altitudes.length
        ? "Altitudes importadas do ficheiro GPX."
        : "Altimetria por carregar.";
    }

    if (el.mapHint) {
      el.mapHint.textContent =
        "GPX importado. Clica num marcador para selecionar um ponto.";
    }

    setStatus(GPX importado: ${points.length} pontos.);
  }

  function addImportButton() {
    if (!el.exportBtn || $("importGPXBtn")) return;

    const button = document.createElement("button");

    button.id = "importGPXBtn";
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = "↑ Importar GPX";

    button.addEventListener("click", () => {
      ensureImportInput().click();
    });

    el.exportBtn.parentNode?.insertBefore(button, el.exportBtn);
  }

  /* ----------------------------------------------------------
     EVENTOS
     ---------------------------------------------------------- */

  function bindEvents() {
    el.createRouteBtn?.addEventListener("click", createRoute);
    el.deletePointBtn?.addEventListener("click", deleteSelectedPoint);
    el.undoBtn?.addEventListener("click", undoLastChange);
    el.clearRouteBtn?.addEventListener("click", clearRoute);
    el.newRouteBtn?.addEventListener("click", newRoute);
    el.exportBtn?.addEventListener("click", exportGPX);
    el.loadElevationBtn?.addEventListener("click", loadElevation);

    el.mapType?.addEventListener("change", () => {
      setMapType(el.mapType.value);
    });

    el.themeSelect?.addEventListener("change", () => {
      setTheme(el.themeSelect.value);
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
      if (map) map.invalidateSize();
      renderElevationChart();
    });
  }

  /* ----------------------------------------------------------
     INICIALIZAÇÃO
     ---------------------------------------------------------- */

  function init() {
    if (!initMap()) return;

    lastRouteType = el.routeType?.value || "linear";

    createLocationSearch();
    bindEvents();
    addImportButton();
    updateRouteLine();
    updateMarkers();
    updateStats();
    renderElevationChart();
    updateEditButtons();
    setTheme(currentTheme);

    if (el.mapHint) {
      el.mapHint.textContent =
        "Pesquisa uma localidade ou clica no mapa para adicionar pontos.";
    }

    setStatus("Pronto para criar um percurso.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* ========================================
   自驾车差旅报销轨迹核查工具 — 核心逻辑
   ======================================== */

// ==================== 密码门禁 ====================
const AUTH_KEY = 'travel_audit_auth';

function initAuth() {
    const overlay = document.getElementById('authOverlay');
    const passwordInput = document.getElementById('authPassword');
    const submitBtn = document.getElementById('authSubmitBtn');
    const errorEl = document.getElementById('authError');
    const messageEl = document.getElementById('authMessage');
    const resetBtn = document.getElementById('authResetBtn');

    // 检查是否已验证（sessionStorage，关闭浏览器自动清除）
    if (sessionStorage.getItem(AUTH_KEY) === 'ok') {
        overlay.style.display = 'none';
        return;
    }

    // 检查是否有已保存的密码哈希
    const savedHash = localStorage.getItem(AUTH_KEY);

    if (!savedHash) {
        // 首次使用：设置密码
        messageEl.textContent = '首次使用，请设置访问密码';
        submitBtn.textContent = '设置密码';
        resetBtn.style.display = 'none';
    } else {
        // 已有密码：验证
        messageEl.textContent = '请输入访问密码';
        submitBtn.textContent = '验证';
    }

    overlay.style.display = 'flex';
    passwordInput.focus();

    function doAuth() {
        const password = passwordInput.value.trim();
        if (!password) {
            showError('请输入密码');
            return;
        }
        if (password.length < 4) {
            showError('密码至少4位');
            return;
        }

        if (!savedHash) {
            // 首次设置密码
            hashPassword(password).then(hash => {
                localStorage.setItem(AUTH_KEY, hash);
                sessionStorage.setItem(AUTH_KEY, 'ok');
                overlay.style.display = 'none';
                setStatus('密码已设置，下次访问需输入密码');
            });
        } else {
            // 验证密码
            hashPassword(password).then(hash => {
                if (hash === savedHash) {
                    sessionStorage.setItem(AUTH_KEY, 'ok');
                    overlay.style.display = 'none';
                    setStatus('验证通过 ✓');
                } else {
                    showError('密码错误，请重试');
                    passwordInput.value = '';
                    passwordInput.focus();
                }
            });
        }
    }

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
        setTimeout(() => { errorEl.style.display = 'none'; }, 3000);
    }

    submitBtn.addEventListener('click', doAuth);
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doAuth();
    });

    // 重置密码（需输入旧密码确认）
    resetBtn.addEventListener('click', () => {
        const oldPwd = prompt('请输入当前密码以确认重置：');
        if (!oldPwd) return;
        hashPassword(oldPwd).then(hash => {
            if (hash === savedHash) {
                localStorage.removeItem(AUTH_KEY);
                sessionStorage.removeItem(AUTH_KEY);
                alert('密码已重置，页面将刷新');
                location.reload();
            } else {
                alert('密码错误，无法重置');
            }
        });
    });
}

// SHA-256 哈希（使用 Web Crypto API）
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'travel-audit-salt');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== 全局状态 ====================
const state = {
    apiKey: '',
    securityCode: '',
    mapLoaded: false,
    map: null,
    rawData: null,           // 原始解析数据（二维数组，首行为表头）
    headers: [],             // 列名列表
    parsedRows: [],          // 解析后的数据行
    timeCol: '',             // 用户选择的时间列名
    lngCol: '',              // 用户选择的经度列名
    latCol: '',              // 用户选择的纬度列名
    placeCol: '',            // （可选）地点列名
    gpsPoints: [],           // 清洗后的 GPS 点 [{time, lng, lat, date}]
    dateGroups: {},          // 按日期分组 { '2024-01-01': [points] }
    allDates: [],            // 所有日期（排序后）
    selectedDates: new Set(),// 选中的日期
    trajectories: [],        // 地图上的轨迹对象 {polyline, markers, date}
    workPlaces: [],          // 工作地点 [{name, lng, lat, address}]
    workPlaceMarkers: [],    // 工作地点地图标记
    geocoder: null,          // 高德地理编码器
    dateColors: {},          // 日期 → 颜色映射
};

// ==================== 配额追踪 ====================
const QUOTA_STORAGE_KEY = 'travel_audit_quota';

// 默认配额上限（用户可修改）
const DEFAULT_QUOTA_LIMITS = {
    lbs: 150000,       // 地图基础LBS服务（JS API 地图展示）
    positioning: 150000, // 基础地图定位服务（地理编码）
    search: 5000,      // 基础搜索服务（POI搜索）
};

// 读取/初始化配额数据
function loadQuota() {
    try {
        const raw = localStorage.getItem(QUOTA_STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            // 检查是否需要月度重置
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            if (data.month !== currentMonth) {
                return createFreshQuota();
            }
            return data;
        }
    } catch (e) { /* ignore */ }
    return createFreshQuota();
}

function createFreshQuota() {
    const now = new Date();
    return {
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        counts: { lbs: 0, positioning: 0, search: 0 },
        limits: { ...DEFAULT_QUOTA_LIMITS },
        locked: { lbs: false, positioning: false, search: false },
    };
}

function saveQuota(quota) {
    try {
        localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(quota));
    } catch (e) { /* ignore */ }
}

let _quota = loadQuota();

function getQuota() {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (_quota.month !== currentMonth) {
        _quota = createFreshQuota();
        saveQuota(_quota);
    }
    return _quota;
}

// 判断是否被锁定
function isQuotaLocked(type) {
    return getQuota().locked[type];
}

// 增加计数，返回是否成功（false = 已超额被拒绝）
function incrementQuota(type, amount = 1) {
    const quota = getQuota();
    if (quota.locked[type]) return false;
    quota.counts[type] += amount;
    if (quota.counts[type] >= quota.limits[type]) {
        quota.locked[type] = true;
        saveQuota(quota);
        updateQuotaDisplay();
        return false;
    }
    saveQuota(quota);
    updateQuotaDisplay();
    return true;
}

// 更新配额上限
function updateQuotaLimit(type, newLimit) {
    const quota = getQuota();
    const num = parseInt(newLimit, 10);
    if (isNaN(num) || num <= 0) return false;
    quota.limits[type] = num;
    // 如果新上限大于当前用量，解锁
    if (quota.counts[type] < num) {
        quota.locked[type] = false;
    }
    saveQuota(quota);
    updateQuotaDisplay();
    return true;
}

// 手动解锁/重置配额
function resetQuota() {
    _quota = createFreshQuota();
    saveQuota(_quota);
    updateQuotaDisplay();
}

// 渲染配额面板
function updateQuotaDisplay() {
    const container = document.getElementById('quotaPanel');
    if (!container) return;
    const quota = getQuota();

    const services = [
        { key: 'lbs',         label: '地图 LBS 服务',    icon: '🗺️' },
        { key: 'positioning', label: '地图定位服务',      icon: '📍' },
        { key: 'search',      label: '基础搜索服务',      icon: '🔍' },
    ];

    let html = '';
    services.forEach(s => {
        const used = quota.counts[s.key];
        const limit = quota.limits[s.key];
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const locked = quota.locked[s.key];
        const warn = pct >= 90;

        html += `
            <div class="quota-item ${locked ? 'quota-locked' : ''} ${warn && !locked ? 'quota-warn' : ''}">
                <div class="quota-header">
                    <span>${s.icon} ${s.label}</span>
                    <span class="quota-status">${locked ? '🔒 已锁定' : warn ? '⚠️ 接近上限' : '✅'}</span>
                </div>
                <div class="quota-bar-wrap">
                    <div class="quota-bar" style="width:${pct}%; background:${locked ? '#ff4d4f' : pct >= 90 ? '#faad14' : '#1677ff'};"></div>
                </div>
                <div class="quota-numbers">
                    <span>${used.toLocaleString()} / ${limit.toLocaleString()}</span>
                    <span>${pct.toFixed(1)}%</span>
                </div>
                <div class="quota-limit-set">
                    <input type="number" value="${limit}" min="1"
                        onchange="updateQuotaLimit('${s.key}', this.value)"
                        class="quota-limit-input" title="修改上限">
                </div>
            </div>
        `;
    });

    container.innerHTML = html + `
        <div style="margin-top:10px;display:flex;gap:6px;">
            <button class="btn btn-xs" onclick="resetQuota()" title="将本月计数归零并解锁所有服务">🔄 重置本月配额</button>
        </div>
        <p class="hint" style="margin-top:6px;">计数存储在浏览器本地，每月自动重置</p>
    `;
}

// ==================== 颜色调色板 ====================
const COLOR_PALETTE = [
    '#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1',
    '#13c2c2', '#eb2f96', '#faad14', '#2f54eb', '#a0d911',
    '#fa541c', '#531dab', '#00968b', '#c41d7f', '#d48806',
    '#0958d9', '#389e0d', '#d4380d', '#7c3aed', '#0891b2',
];

// ==================== 高德 API Key 管理 ====================
function initApiKey() {
    // 硬编码 Key（密码门禁保护，外人看不到）
    const builtinKey = 'bcdaa50636b045e306bac2b32ab3cce1';
    state.apiKey = builtinKey;
    document.getElementById('apiKeyInput').value = builtinKey;
    updateApiKeyStatus('地图 API 加载中...', 'success');
    loadAmapScript();
}

function updateApiKeyStatus(msg, type) {
    const el = document.getElementById('apiKeyStatus');
    el.textContent = msg;
    el.className = `status-text ${type}`;
}

// ==================== 高德地图脚本加载 ====================
function loadAmapScript() {
    if (state.mapLoaded) return;
    if (!state.apiKey) return;

    // 避免重复加载
    if (document.getElementById('amap-script')) return;
    if (window.AMap) {
        initMap();
        return;
    }

    // 2021年12月后创建的 Key 需要配置安全密钥
    if (state.securityCode) {
        window._AMapSecurityConfig = {
            securityJsCode: state.securityCode,
        };
    }

    const script = document.createElement('script');
    script.id = 'amap-script';
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${state.apiKey}`;
    script.onload = () => {
        state.mapLoaded = true;
        initMap();
        updateApiKeyStatus('地图 API 已就绪 ✓', 'success');
    };
    script.onerror = () => {
        updateApiKeyStatus('地图加载失败，请检查 API Key 和安全密钥', 'error');
    };
    document.head.appendChild(script);
}

// ==================== 地图初始化 ====================
function initMap() {
    if (!window.AMap) return;

    const container = document.getElementById('mapContainer');
    const fallback = document.getElementById('mapFallback');

    container.style.display = 'block';
    fallback.style.display = 'none';

    // 加载所需插件后初始化地图
    AMap.plugin(['AMap.Scale', 'AMap.ToolBar', 'AMap.Geocoder'], function () {
        // 检查 LBS 配额
        if (isQuotaLocked('lbs')) {
            setStatus('⚠️ 本月地图LBS服务配额已用尽，地图功能已锁定。请等待下月重置或调整配额上限。');
            updateQuotaDisplay();
            return;
        }

        // 增加 LBS 计数
        if (!incrementQuota('lbs')) {
            setStatus('⚠️ 地图加载已超过本月LBS配额上限，功能已锁定！');
            return;
        }

        state.map = new AMap.Map('mapContainer', {
            zoom: 11,
            center: [116.397428, 39.90923], // 默认北京中心
            viewMode: '2D',
            mapStyle: 'amap://styles/light',
        });

        // 添加地图控件
        state.map.addControl(new AMap.Scale());
        state.map.addControl(new AMap.ToolBar({ position: 'LT' }));

        // 初始化地理编码器
        state.geocoder = new AMap.Geocoder();

        // 恢复已保存的工作地点标记
        if (state.workPlaces.length > 0) {
            renderWorkPlaceMarkers();
            updateLegend();
        }

        setStatus('地图已就绪，请上传数据文件');
    });
}

// ==================== 文件上传 ====================
function initFileUpload() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    // 点击上传
    dropZone.addEventListener('click', () => fileInput.click());

    // 文件选择
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // 拖拽上传
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });
}

function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext)) {
        alert('不支持的文件格式，请上传 .xlsx / .xls / .csv 文件');
        return;
    }

    setStatus(`正在解析文件: ${file.name} ...`);

    if (ext === 'csv') {
        parseCSV(file);
    } else {
        parseExcel(file);
    }
}

// ==================== CSV 解析 ====================
function parseCSV(file) {
    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: 'UTF-8',
        complete: (results) => {
            if (results.errors.length > 0) {
                console.warn('CSV 解析警告:', results.errors);
            }
            state.rawData = results.data;
            state.headers = results.meta.fields || [];
            onDataParsed(file);
        },
        error: (err) => {
            alert('CSV 解析失败: ' + err.message);
            setStatus('CSV 解析失败');
        },
    });
}

// ==================== Excel 解析 ====================
function parseExcel(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) {
                alert('Excel 文件中没有找到工作表');
                return;
            }
            const firstSheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });

            if (!jsonData || jsonData.length === 0) {
                alert('Excel 文件为空或无法读取');
                return;
            }

            // 第一行作为表头，确保都是字符串
            const rawHeaders = jsonData[0] || [];
            const headers = rawHeaders.map(h => {
                if (h === undefined || h === null) return '';
                return String(h).trim();
            });

            // 过滤掉完全空的表头行（如果第一行全是空的，尝试用第二行）
            const allEmpty = headers.every(h => h === '');
            if (allEmpty && jsonData.length > 1) {
                const secondRow = jsonData[1] || [];
                const secondHeaders = secondRow.map(h => {
                    if (h === undefined || h === null) return '';
                    return String(h).trim();
                });
                // 如果第二行也不是全空，用它作为表头
                if (!secondHeaders.every(h => h === '')) {
                    headers.length = 0;
                    headers.push(...secondHeaders);
                    jsonData.splice(1, 1); // 移除用作表头的行
                }
            }

            const rows = jsonData.slice(1);

            // 转换为对象数组
            state.rawData = rows.map(row => {
                const obj = {};
                headers.forEach((h, i) => {
                    obj[h] = (row && row[i] !== undefined && row[i] !== null) ? row[i] : '';
                });
                return obj;
            });
            state.headers = headers;

            onDataParsed(file);
        } catch (err) {
            console.error('Excel 解析错误:', err);
            alert('Excel 解析失败: ' + (err.message || err) + '\n\n请确认：\n1. 文件未被加密或损坏\n2. 文件是标准的 .xlsx 或 .xls 格式\n3. 可尝试另存为 .csv 格式再上传');
            setStatus('Excel 解析失败');
        }
    };
    reader.onerror = () => {
        alert('文件读取失败，请重试');
        setStatus('文件读取失败');
    };
    reader.readAsArrayBuffer(file);
}

// ==================== 数据解析后处理 ====================
function onDataParsed(file) {
    const rowCount = state.rawData.length;
    const colCount = state.headers.length;

    // 显示文件信息
    const fileInfo = document.getElementById('fileInfo');
    fileInfo.style.display = 'flex';
    document.getElementById('fileName').innerHTML = `<span class="file-name">📄 ${file.name}</span>`;
    document.getElementById('rowCount').textContent = `${rowCount} 行 × ${colCount} 列`;

    // 显示列映射面板
    showMappingPanel();

    // 显示数据预览
    showDataPreview();

    setStatus(`文件解析完成：${rowCount} 行数据，${colCount} 列，请配置列映射`);
}

// ==================== 列映射 ====================
function showMappingPanel() {
    const panel = document.getElementById('mappingPanel');
    panel.style.display = 'block';

    const headers = state.headers;
    const timeSelect = document.getElementById('timeColumn');
    const lngSelect = document.getElementById('lngColumn');
    const latSelect = document.getElementById('latColumn');
    const placeSelect = document.getElementById('placeColumn');

    // 清空并填充选项
    [timeSelect, lngSelect, latSelect, placeSelect].forEach(sel => {
        sel.innerHTML = '<option value="">-- 请选择 --</option>';
        headers.forEach(h => {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h;
            sel.appendChild(opt);
        });
    });

    // 自动检测列名
    autoDetectColumns(headers, timeSelect, lngSelect, latSelect, placeSelect);
}

function autoDetectColumns(headers, timeSelect, lngSelect, latSelect, placeSelect) {
    // 安全检查：确保所有 headers 都是字符串
    const safeHeaders = headers.map(h => (typeof h === 'string' ? h : String(h || '')));
    const lowerHeaders = safeHeaders.map(h => h.toLowerCase().trim());

    // 时间列检测
    const timePatterns = ['时间', '日期', 'date', 'time', 'datetime', 'timestamp', '时刻', 'time_stamp', 'created'];
    const timeIdx = lowerHeaders.findIndex(h => h && timePatterns.some(p => h.includes(p)));
    if (timeIdx >= 0) timeSelect.value = safeHeaders[timeIdx];

    // 经度列检测
    const lngPatterns = ['经度', 'longitude', 'lng', 'lon', 'long', 'x坐标', 'x'];
    const lngIdx = lowerHeaders.findIndex(h => h && lngPatterns.some(p => h.includes(p)));
    if (lngIdx >= 0) lngSelect.value = safeHeaders[lngIdx];

    // 纬度列检测
    const latPatterns = ['纬度', 'latitude', 'lat', 'y坐标', 'y'];
    const latIdx = lowerHeaders.findIndex(h => h && latPatterns.some(p => h.includes(p)));
    if (latIdx >= 0) latSelect.value = safeHeaders[latIdx];

    // 地点列检测（可选）
    const placePatterns = ['地点', '地址', '位置', '备注', '描述', 'place', 'address', 'location', 'addr', 'site', 'desc', 'remark'];
    const placeIdx = lowerHeaders.findIndex(h => h && placePatterns.some(p => h.includes(p)));
    if (placeIdx >= 0) placeSelect.value = safeHeaders[placeIdx];

    // 如果都检测到了，高亮提示
    if (timeIdx >= 0 && lngIdx >= 0 && latIdx >= 0) {
        const extra = placeIdx >= 0 ? '，已检测到地点列' : '';
        setStatus('已自动检测到时间、经度、纬度列' + extra + '，请确认后点击"应用并加载轨迹"');
    }
}

// 应用列映射按钮
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('applyMappingBtn').addEventListener('click', applyMapping);
});

function applyMapping() {
    state.timeCol = document.getElementById('timeColumn').value;
    state.lngCol = document.getElementById('lngColumn').value;
    state.latCol = document.getElementById('latColumn').value;
    state.placeCol = document.getElementById('placeColumn').value;

    if (!state.timeCol || !state.lngCol || !state.latCol) {
        alert('请为时间、经度、纬度分别选择对应的列');
        return;
    }

    if (state.timeCol === state.lngCol || state.timeCol === state.latCol || state.lngCol === state.latCol) {
        alert('时间、经度、纬度必须选择不同的列');
        return;
    }

    processData();
}

// ==================== 数据处理与清洗 ====================
function processData() {
    const points = [];

    for (const row of state.rawData) {
        const timeRaw = row[state.timeCol];
        const lngRaw = row[state.lngCol];
        const latRaw = row[state.latCol];

        // 跳过空值
        if (timeRaw === undefined || timeRaw === null || timeRaw === '' ||
            lngRaw === undefined || lngRaw === null || lngRaw === '' ||
            latRaw === undefined || latRaw === null || latRaw === '') {
            continue;
        }

        // 解析时间
        const time = parseTime(timeRaw);
        if (!time) continue;

        // 解析经纬度
        const lng = parseFloat(lngRaw);
        const lat = parseFloat(latRaw);

        // 验证经纬度（中国范围 + 合理范围）
        if (isNaN(lng) || isNaN(lat)) continue;
        if (lng < 70 || lng > 140) continue;
        if (lat < 15 || lat > 55) continue;

        const dateStr = formatDate(time);

        // 地点列（可选）
        let place = '';
        if (state.placeCol) {
            const placeRaw = row[state.placeCol];
            if (placeRaw !== undefined && placeRaw !== null) {
                place = String(placeRaw).trim();
            }
        }

        points.push({
            time: time,
            lng: lng,
            lat: lat,
            date: dateStr,
            place: place,
        });
    }

    if (points.length === 0) {
        alert('未能从数据中提取有效的 GPS 点，请检查列映射配置和数据内容');
        setStatus('数据处理失败：无有效 GPS 点');
        return;
    }

    // 按时间排序
    points.sort((a, b) => a.time - b.time);

    state.gpsPoints = points;

    // 按日期分组
    state.dateGroups = {};
    for (const p of points) {
        if (!state.dateGroups[p.date]) {
            state.dateGroups[p.date] = [];
        }
        state.dateGroups[p.date].push(p);
    }

    // 日期列表排序
    state.allDates = Object.keys(state.dateGroups).sort();

    // 分配颜色
    state.allDates.forEach((d, i) => {
        state.dateColors[d] = COLOR_PALETTE[i % COLOR_PALETTE.length];
    });

    // 默认全选
    state.selectedDates = new Set(state.allDates);

    // 初始化日期切片器
    initDateSlicer();

    // 渲染轨迹
    renderAllTrajectories();

    // 显示面板
    document.getElementById('dateSlicerPanel').style.display = 'block';
    document.getElementById('workplacePanel').style.display = 'block';
    document.getElementById('previewPanel').style.display = 'block';

    // 渲染已保存的工作地点标记
    renderWorkPlaceMarkers();

    setStatus(`数据处理完成：${points.length} 个有效 GPS 点，${state.allDates.length} 个日期`);
}

// ==================== 时间解析 ====================
function parseTime(raw) {
    if (raw instanceof Date) return raw;

    const str = String(raw).trim();

    // 尝试解析 Excel 序列号（数字）
    const num = parseFloat(str);
    if (!isNaN(num) && num > 30000 && num < 100000) {
        // Excel 日期序列号（1900 起算）
        const excelEpoch = new Date(1899, 11, 30);
        const d = new Date(excelEpoch.getTime() + num * 86400000);
        if (!isNaN(d.getTime())) return d;
    }

    // 尝试多种日期格式
    // ISO 格式: 2024-01-15T08:30:00
    let d = new Date(str);
    if (!isNaN(d.getTime())) return d;

    // 常见中文格式: 2024-01-15 08:30:00
    d = new Date(str.replace(/\s/g, 'T'));
    if (!isNaN(d.getTime())) return d;

    // 2024/01/15 08:30:00
    d = new Date(str.replace(/\//g, '-').replace(/\s/g, 'T'));
    if (!isNaN(d.getTime())) return d;

    // 2024年1月15日 8:30:00
    const cnMatch = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2}):(\d{2})/);
    if (cnMatch) {
        d = new Date(cnMatch[1], cnMatch[2] - 1, cnMatch[3], cnMatch[4], cnMatch[5], cnMatch[6]);
        if (!isNaN(d.getTime())) return d;
    }

    // 2024-01-15
    const dateOnly = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (dateOnly) {
        d = new Date(dateOnly[1], dateOnly[2] - 1, dateOnly[3]);
        if (!isNaN(d.getTime())) return d;
    }

    return null;
}

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatDateTime(date) {
    const dateStr = formatDate(date);
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${dateStr} ${h}:${min}:${s}`;
}

// ==================== 数据预览 ====================
function showDataPreview() {
    const panel = document.getElementById('previewPanel');
    panel.style.display = 'block';
    const wrap = document.getElementById('previewTable');

    // 根据选中的日期筛选 GPS 点
    let filteredPoints = state.gpsPoints;
    if (state.selectedDates.size > 0 && state.selectedDates.size < state.allDates.length) {
        filteredPoints = state.gpsPoints.filter(p => state.selectedDates.has(p.date));
    }

    const maxShow = 50;
    const previewRows = filteredPoints.slice(0, maxShow);

    if (previewRows.length === 0) {
        wrap.innerHTML = '<p class="hint" style="text-align:center;padding:16px;">暂无数据，请选择日期</p>';
        return;
    }

    // 检查是否有地点列
    const hasPlace = !!state.placeCol;

    let html = '<table><thead><tr><th>#</th><th>时间</th>';
    if (hasPlace) html += '<th>地点</th>';
    html += '</tr></thead><tbody>';

    previewRows.forEach((p, i) => {
        html += `<tr>
            <td>${i + 1}</td>
            <td>${formatDateTime(p.time)}</td>`;
        if (hasPlace) {
            html += `<td class="addr-cell">${escapeHtml(p.place || '')}</td>`;
        }
        html += '</tr>';
    });

    html += '</tbody></table>';

    const total = filteredPoints.length;
    if (total > maxShow) {
        html += `<p class="hint" style="padding:8px;text-align:center;">显示前 ${maxShow} 条，当前筛选共 ${total} 条 GPS 点</p>`;
    } else {
        html += `<p class="hint" style="padding:8px;text-align:center;">当前筛选共 ${total} 条 GPS 点</p>`;
    }

    wrap.innerHTML = html;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ==================== 轨迹渲染 ====================
function renderAllTrajectories() {
    if (!state.map) {
        alert('请先配置高德 API Key 并加载地图');
        return;
    }

    clearTrajectories();

    const allPoints = [];

    for (const date of state.allDates) {
        if (!state.selectedDates.has(date)) continue;

        const points = state.dateGroups[date];
        const color = state.dateColors[date];

        // 创建轨迹线（GPS点之间直线连接，零配额消耗）
        const path = points.map(p => [p.lng, p.lat]);
        const polyline = new AMap.Polyline({
            path: path,
            strokeColor: color,
            strokeWeight: 6,
            strokeOpacity: 0.85,
            lineJoin: 'round',
            lineCap: 'round',
            showDir: true,
            dirColor: '#ffffff',
            zIndex: 10,
        });
        polyline.setMap(state.map);

        // 起点标记
        const startPoint = points[0];
        const startMarker = new AMap.Marker({
            position: [startPoint.lng, startPoint.lat],
            icon: createMarkerIcon(color, 'start'),
            offset: new AMap.Pixel(-6, -6),
            zIndex: 50,
            title: `起点: ${formatDateTime(startPoint.time)}`,
        });
        startMarker.setMap(state.map);
        startMarker.on('click', () => showPointInfo(startPoint, '起点', color));

        // 终点标记
        const endPoint = points[points.length - 1];
        const endMarker = new AMap.Marker({
            position: [endPoint.lng, endPoint.lat],
            icon: createMarkerIcon('#f5222d', 'end'),
            offset: new AMap.Pixel(-6, -6),
            zIndex: 50,
            title: `终点: ${formatDateTime(endPoint.time)}`,
        });
        endMarker.setMap(state.map);
        endMarker.on('click', () => showPointInfo(endPoint, '终点', color));

        // 中间点
        const midMarkers = [];
        for (let i = 1; i < points.length - 1; i++) {
            const p = points[i];
            const marker = new AMap.Marker({
                position: [p.lng, p.lat],
                icon: createDotIcon(color),
                offset: new AMap.Pixel(-3, -3),
                zIndex: 30,
                title: formatDateTime(p.time),
            });
            marker.setMap(state.map);
            marker.on('click', () => showPointInfo(p, `途经点 #${i + 1}`, color));
            midMarkers.push(marker);
        }

        state.trajectories.push({
            date: date,
            polyline: polyline,
            startMarker: startMarker,
            endMarker: endMarker,
            midMarkers: midMarkers,
        });

        allPoints.push(...points);
    }

    // 自动调整地图视野
    if (allPoints.length > 0) {
        state.map.setFitView(null, false, [100, 100, 380, 100]);
    }

    updateLegend();
}

function clearTrajectories() {
    for (const traj of state.trajectories) {
        traj.polyline.setMap(null);
        traj.startMarker.setMap(null);
        traj.endMarker.setMap(null);
        traj.midMarkers.forEach(m => m.setMap(null));
    }
    state.trajectories = [];
}

function createMarkerIcon(color, type) {
    const size = type === 'start' || type === 'end' ? 16 : 12;
    return new AMap.Icon({
        size: new AMap.Size(size, size),
        image: getCircleSVGDataUrl(color, size),
        imageSize: new AMap.Size(size, size),
    });
}

function createDotIcon(color) {
    return new AMap.Icon({
        size: new AMap.Size(6, 6),
        image: getCircleSVGDataUrl(color, 6),
        imageSize: new AMap.Size(6, 6),
    });
}

// 用 SVG data URL 创建圆点图标（避免外部图片依赖）
function getCircleSVGDataUrl(color, size) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 1}" fill="${color}" stroke="#fff" stroke-width="1"/>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// 创建五角星 SVG（用于工作地点标记）
function getStarSVGDataUrl(color, size) {
    const cx = size / 2, cy = size / 2, r = size / 2 - 2;
    const points = [];
    for (let i = 0; i < 5; i++) {
        const outerAngle = (i * 72 - 90) * Math.PI / 180;
        const innerAngle = ((i * 72) + 36 - 90) * Math.PI / 180;
        points.push(`${cx + r * Math.cos(outerAngle)},${cy + r * Math.sin(outerAngle)}`);
        points.push(`${cx + r * 0.4 * Math.cos(innerAngle)},${cy + r * 0.4 * Math.sin(innerAngle)}`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <polygon points="${points.join(' ')}" fill="${color}" stroke="#fff" stroke-width="1"/>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function showPointInfo(point, label, color) {
    const content = `
        <div style="padding:4px 0;">
            <strong>${label}</strong><br>
            <span style="color:${color};">● ${point.date}</span><br>
            时间：${formatDateTime(point.time)}<br>
            经度：${point.lng.toFixed(6)}<br>
            纬度：${point.lat.toFixed(6)}
        </div>
    `;

    const infoWindow = new AMap.InfoWindow({
        content: content,
        offset: new AMap.Pixel(0, -20),
    });
    infoWindow.open(state.map, [point.lng, point.lat]);
}

// ==================== 日期切片器 ====================
function initDateSlicer() {
    const container = document.getElementById('dateCheckboxList');
    let html = '';

    state.allDates.forEach(date => {
        const color = state.dateColors[date];
        const count = state.dateGroups[date].length;
        html += `
            <label>
                <input type="checkbox" value="${date}" checked onchange="onDateToggle()">
                <span class="date-color-dot" style="background:${color};" title="${count} 个 GPS 点"></span>
                ${date} <span style="color:#999;font-size:11px;">(${count}点)</span>
            </label>
        `;
    });

    container.innerHTML = html;

    // 全选/取消全选/反选
    document.getElementById('selectAllDates').onclick = () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        onDateToggle();
    };
    document.getElementById('deselectAllDates').onclick = () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        onDateToggle();
    };
    document.getElementById('invertDates').onclick = () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = !cb.checked);
        onDateToggle();
    };
}

function onDateToggle() {
    const checkboxes = document.querySelectorAll('#dateCheckboxList input[type="checkbox"]');
    state.selectedDates = new Set();
    checkboxes.forEach(cb => {
        if (cb.checked) state.selectedDates.add(cb.value);
    });

    renderAllTrajectories();
    renderWorkPlaceMarkers(); // 重绘工作地点（确保在轨迹上层）
    showDataPreview();        // 刷新数据预览

    const count = state.selectedDates.size;
    setStatus(`已选择 ${count}/${state.allDates.length} 个日期`);
}

// ==================== 图例 ====================
function updateLegend() {
    const legend = document.getElementById('mapLegend');

    if (Object.keys(state.dateGroups).length === 0) {
        legend.style.display = 'none';
        return;
    }

    let html = '<h4>📋 图例</h4>';

    // 轨迹线
    for (const date of state.allDates) {
        if (!state.selectedDates.has(date)) continue;
        const color = state.dateColors[date];
        html += `
            <div class="legend-item">
                <span class="legend-line" style="background:${color};"></span>
                ${date}
            </div>
        `;
    }

    // 起终点说明
    html += `
        <div class="legend-item" style="margin-top:6px;">
            <span class="legend-dot" style="background:#52c41a;"></span> 起点
        </div>
        <div class="legend-item">
            <span class="legend-dot" style="background:#f5222d;"></span> 终点
        </div>
    `;

    // 工作地点
    if (state.workPlaces.length > 0) {
        html += `
            <div class="legend-item" style="margin-top:6px;">
                <span class="legend-star">⭐</span> 工作地点
            </div>
        `;
    }

    legend.innerHTML = html;
    legend.style.display = 'block';
}

// ==================== 工作地点管理 ====================
function initWorkplaceManager() {
    // 从 localStorage 恢复
    const saved = localStorage.getItem('travel_audit_workplaces');
    if (saved) {
        try {
            state.workPlaces = JSON.parse(saved);
            renderWorkplaceList();
        } catch (e) {
            state.workPlaces = [];
        }
    }

    document.getElementById('addWorkplaceBtn').addEventListener('click', addWorkplace);

    // 地址输入框支持回车搜索
    document.getElementById('wpAddress').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            geocodeAddress();
        }
    });

    // 地址失焦时自动查询
    document.getElementById('wpAddress').addEventListener('blur', () => {
        geocodeAddress();
    });
}

function geocodeAddress() {
    const address = document.getElementById('wpAddress').value.trim();
    if (!address) return;
    if (!state.geocoder) {
        console.warn('地理编码器尚未就绪，请等待地图加载完成');
        return;
    }

    // 检查定位配额
    if (isQuotaLocked('positioning')) {
        alert('⚠️ 本月地图定位服务配额已用尽，地址查询功能已锁定。\n请等待下月重置，或调整配额上限。');
        return;
    }

    // 增加定位计数
    if (!incrementQuota('positioning')) {
        alert('⚠️ 本次地址查询将超过配额上限，功能已锁定！\n请等待下月重置，或调整配额上限。');
        return;
    }

    state.geocoder.getLocation(address, (status, result) => {
        if (status === 'complete' && result.info === 'OK') {
            const geocode = result.geocodes[0];
            document.getElementById('wpLng').value = geocode.location.lng.toFixed(6);
            document.getElementById('wpLat').value = geocode.location.lat.toFixed(6);
            setStatus(`地址解析成功：${geocode.formattedAddress}`);
        } else {
            console.warn('地址解析失败:', status, result);
        }
    });
}

function addWorkplace() {
    const name = document.getElementById('wpName').value.trim();
    const address = document.getElementById('wpAddress').value.trim();
    const lng = parseFloat(document.getElementById('wpLng').value);
    const lat = parseFloat(document.getElementById('wpLat').value);

    if (!name) {
        alert('请输入地点名称');
        return;
    }
    if (isNaN(lng) || isNaN(lat)) {
        alert('请输入有效的经纬度，或在"地址"框中输入地址自动查询');
        return;
    }
    if (lng < 70 || lng > 140 || lat < 15 || lat > 55) {
        alert('经纬度超出中国范围，请检查');
        return;
    }

    // 检查重复
    if (state.workPlaces.some(wp => wp.name === name)) {
        alert(`工作地点 "${name}" 已存在`);
        return;
    }

    const place = { name, address, lng, lat };
    state.workPlaces.push(place);
    saveWorkplaces();
    renderWorkplaceList();
    renderWorkPlaceMarkers();
    updateLegend();

    // 清空输入
    document.getElementById('wpName').value = '';
    document.getElementById('wpAddress').value = '';
    document.getElementById('wpLng').value = '';
    document.getElementById('wpLat').value = '';

    setStatus(`已添加工作地点：${name}`);
}

function deleteWorkplace(index) {
    const place = state.workPlaces[index];
    if (!confirm(`确定删除工作地点 "${place.name}"？`)) return;

    state.workPlaces.splice(index, 1);
    saveWorkplaces();
    renderWorkplaceList();
    renderWorkPlaceMarkers();
    updateLegend();

    setStatus(`已删除工作地点：${place.name}`);
}

function saveWorkplaces() {
    localStorage.setItem('travel_audit_workplaces', JSON.stringify(state.workPlaces));
}

function renderWorkplaceList() {
    const container = document.getElementById('workplaceList');
    if (state.workPlaces.length === 0) {
        container.innerHTML = '<p class="hint" style="text-align:center;padding:12px;">暂无工作地点</p>';
        return;
    }

    let html = '';
    state.workPlaces.forEach((place, i) => {
        html += `
            <div class="workplace-item">
                <span class="wp-icon">⭐</span>
                <div class="wp-info">
                    <div class="wp-name">${escapeHtml(place.name)}</div>
                    <div class="wp-coords">${place.lng.toFixed(5)}, ${place.lat.toFixed(5)}</div>
                </div>
                <button class="wp-delete" title="删除" onclick="deleteWorkplace(${i})">×</button>
            </div>
        `;
    });
    container.innerHTML = html;
}

function renderWorkPlaceMarkers() {
    // 清除旧标记
    if (state.workPlaceMarkers) {
        state.workPlaceMarkers.forEach(m => m.setMap(null));
    }
    state.workPlaceMarkers = [];

    if (!state.map) return;

    state.workPlaces.forEach(place => {
        // 大号星形标记
        const starIcon = new AMap.Icon({
            size: new AMap.Size(32, 32),
            image: getStarSVGDataUrl('#f5222d', 32),
            imageSize: new AMap.Size(32, 32),
        });

        const marker = new AMap.Marker({
            position: [place.lng, place.lat],
            icon: starIcon,
            offset: new AMap.Pixel(-16, -16),
            zIndex: 100,
            title: place.name,
            label: {
                content: `<div style="
                    background:rgba(245,34,45,0.9);
                    color:#fff;
                    padding:2px 8px;
                    border-radius:10px;
                    font-size:12px;
                    font-weight:bold;
                    white-space:nowrap;
                    margin-top:18px;
                    box-shadow:0 2px 4px rgba(0,0,0,0.2);
                ">${escapeHtml(place.name)}</div>`,
                offset: new AMap.Pixel(0, 16),
                direction: 'bottom',
            },
        });

        marker.setMap(state.map);

        // 点击显示信息窗
        marker.on('click', () => {
            const info = new AMap.InfoWindow({
                content: `
                    <div style="padding:4px 0;">
                        <strong>⭐ ${escapeHtml(place.name)}</strong><br>
                        <span style="color:#f5222d;">必经工作地点</span><br>
                        经度：${place.lng.toFixed(6)}<br>
                        纬度：${place.lat.toFixed(6)}<br>
                        ${place.address ? `地址：${escapeHtml(place.address)}` : ''}
                    </div>
                `,
                offset: new AMap.Pixel(0, -36),
            });
            info.open(state.map, [place.lng, place.lat]);
        });

        state.workPlaceMarkers.push(marker);
    });
}

// ==================== 状态栏 ====================
function setStatus(msg) {
    document.getElementById('statusMessage').textContent = msg;
}

// ==================== 应用初始化 ====================
function init() {
    initAuth();
    updateQuotaDisplay();
    initApiKey();
    initFileUpload();
    initWorkplaceManager();
    initSidebarResizer();
    setStatus('就绪 — 请先配置高德 API Key，然后上传数据文件');
}

// ==================== 可拖拽侧边栏 ====================
function initSidebarResizer() {
    const resizer = document.getElementById('sidebarResizer');
    const sidebar = document.querySelector('.sidebar');
    if (!resizer || !sidebar) return;

    const SIDEBAR_MIN = 250;
    const SIDEBAR_MAX = 600;
    const STORAGE_KEY = 'travel_audit_sidebar_width';

    // 恢复已保存的宽度
    const savedWidth = localStorage.getItem(STORAGE_KEY);
    if (savedWidth) {
        const w = parseInt(savedWidth, 10);
        if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) {
            sidebar.style.width = w + 'px';
            sidebar.style.minWidth = w + 'px';
        }
    }

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        let newWidth = startWidth + dx;
        newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, newWidth));
        sidebar.style.width = newWidth + 'px';
        sidebar.style.minWidth = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // 保存宽度
        localStorage.setItem(STORAGE_KEY, String(sidebar.offsetWidth));
    });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);

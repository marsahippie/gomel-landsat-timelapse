// =====================================================================
// ДИПЛОМ: временной ряд Landsat для Гомельского района, 1996–2026
// Этапы 1–3: границы -> разведка данных -> подготовка снимков
//
// Как пользоваться: вставьте весь код в Code Editor и нажмите Run.
// Строки с пометкой "<<< ЗАМЕНИТЕ" нужно поправить под себя.
// =====================================================================


// ---------------------------------------------------------------------
// НАСТРОЙКИ (всё, что может понадобиться менять, собрано здесь)
// ---------------------------------------------------------------------

// Пути к загруженным файлам. Скопируйте их из вкладки Assets
// (кликните на файл -> значок копирования рядом с ID).
var RAYON_PATH = 'projects/gomel-timelapse/assets/gomel_rayon';
var RAMKA_PATH = 'projects/gomel-timelapse/assets/region-ramka';

// Период исследования
var START_YEAR = 1996;
var END_YEAR = 2026;

// Сезон, из которого берём снимки (одинаковый для всех лет!)
var SEASON_START_MONTH = 6;    // с 1 июня
var SEASON_END_MONTH = 10;     // до 1 октября (октябрь не входит), т.е. июнь–сентябрь

// Годы, которые мы проверим глазами на карте
var TEST_YEARS = [1996, 2005, 2012, 2020, 2025];


// =====================================================================
// ЭТАП 1. ГРАНИЦЫ ТЕРРИТОРИИ
// =====================================================================

// Загружаем ваши файлы из Assets
var rayon = ee.FeatureCollection(RAYON_PATH);   // контур района
var ramka = ee.FeatureCollection(RAMKA_PATH);   // прямоугольная рамка

// aoi (area of interest) — область, по которой будем отбирать и обрезать снимки.
// Берём рамку: она прямоугольная, поэтому экспорт и тайлы получатся аккуратными.
var aoi = ramka.geometry();

// Центрируем карту на рамке (число — масштаб, 9–10 подходит для района)
Map.centerObject(ramka, 9);

// Рисуем контуры без заливки: рамка — синяя, район — красный
Map.addLayer(ramka.style({color: '0000FF', fillColor: '00000000', width: 2}), {}, 'Рамка (синяя)');
Map.addLayer(rayon.style({color: 'FF0000', fillColor: '00000000', width: 2}), {}, 'Район (красный)');

// Площади для проверки (в км²). Сверьте с реальными цифрами!
print('Площадь района, км²:', rayon.geometry().area(1).divide(1e6));
print('Площадь рамки, км²:', aoi.area(1).divide(1e6));
print('Границы района (долгота, широта):', rayon.geometry().bounds());

// =====================================================================
// ЭТАП 2. РАЗВЕДКА ДАННЫХ: сколько снимков есть на каждый год
// =====================================================================

// Подключаем 4 коллекции Landsat (Collection 2, Level 2 — уже с атмосферной коррекцией)
// и сразу оставляем только сцены, которые пересекают нашу рамку.
var lt5 = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2').filterBounds(aoi); // Landsat 5 (до 2011)
var le7 = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2').filterBounds(aoi); // Landsat 7 (с 1999)
var lc8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2').filterBounds(aoi); // Landsat 8 (с 2013)
var lc9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2').filterBounds(aoi); // Landsat 9 (с 2021)

// Список лет 1996, 1997, ... 2026
var years = ee.List.sequence(START_YEAR, END_YEAR);

// Для каждого года считаем число сцен каждого спутника за выбранный сезон
var counts = ee.FeatureCollection(years.map(function (y) {
  y = ee.Number(y).int();
  var s = ee.Date.fromYMD(y, SEASON_START_MONTH, 1);
  var e = ee.Date.fromYMD(y, SEASON_END_MONTH, 1);
  return ee.Feature(null, {
    year: y.format('%d'),
    L5: lt5.filterDate(s, e).size(),
    L7: le7.filterDate(s, e).size(),
    L8: lc8.filterDate(s, e).size(),
    L9: lc9.filterDate(s, e).size()
  });
}));

// Столбчатая диаграмма. Считаются СЦЕНЫ, а не даты: одна дата пролёта
// над вашей рамкой — это обычно 2 и более сцен (разные пути/кадры).
print(
  ui.Chart.feature.byFeature(counts, 'year', ['L5', 'L7', 'L8', 'L9'])
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Число сцен Landsat за сезон (июнь–сентябрь) по годам',
      isStacked: true,
      hAxis: {title: 'Год'},
      vAxis: {title: 'Число сцен'}
    })
);
// Годы, где столбика нет или он очень низкий — проблемные. Запишите их.


// =====================================================================
// ЭТАП 3. ПОДГОТОВКА СНИМКОВ
// =====================================================================

// Общие имена каналов, чтобы код работал для всех спутников одинаково
var BAND_NAMES = ['Blue', 'Green', 'Red', 'NIR', 'SWIR1', 'SWIR2'];

// --- Подготовка снимка Landsat 5 и 7 (сенсоры TM и ETM+) ---
function prepTM(img) {
  var qa = img.select('QA_PIXEL');
  // Маска «плохих» пикселей: облако, тень облака, снег, насыщение датчика.
  // Оставляем только пиксели, где ничего из этого нет.
  var mask = qa.bitwiseAnd(1 << 1).eq(0)      // расширенная зона облака
    .and(qa.bitwiseAnd(1 << 3).eq(0))         // облако
    .and(qa.bitwiseAnd(1 << 4).eq(0))         // тень облака
    .and(qa.bitwiseAnd(1 << 5).eq(0))         // снег
    .and(img.select('QA_RADSAT').eq(0));      // насыщение датчика

  // Выбираем 6 нужных каналов, даём общие имена и переводим в
  // настоящие значения отражения (коэффициенты — из документации USGS).
  var optical = img
    .select(['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'], BAND_NAMES)
    .multiply(0.0000275).add(-0.2);

  return optical.updateMask(mask).copyProperties(img, ['system:time_start']);
}

// --- Подготовка снимка Landsat 8 и 9 (сенсор OLI) ---
// Номера каналов у OLI другие (сдвиг на один), поэтому отдельная функция.
function prepOLI(img) {
  var qa = img.select('QA_PIXEL');
  var mask = qa.bitwiseAnd(1 << 1).eq(0)      // расширенная зона облака
    .and(qa.bitwiseAnd(1 << 2).eq(0))         // перистые облака (есть только у Landsat 8/9)
    .and(qa.bitwiseAnd(1 << 3).eq(0))         // облако
    .and(qa.bitwiseAnd(1 << 4).eq(0))         // тень облака
    .and(qa.bitwiseAnd(1 << 5).eq(0))         // снег
    .and(img.select('QA_RADSAT').eq(0));      // насыщение датчика

  var optical = img
    .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'], BAND_NAMES)
    .multiply(0.0000275).add(-0.2);

  return optical.updateMask(mask).copyProperties(img, ['system:time_start']);
}

// --- Все подготовленные снимки одного года (сезон июнь–сентябрь) ---
function seasonCollection(year) {
  year = ee.Number(year).int();
  var s = ee.Date.fromYMD(year, SEASON_START_MONTH, 1);
  var e = ee.Date.fromYMD(year, SEASON_END_MONTH, 1);

  var c5 = lt5.filterDate(s, e).map(prepTM);
  var c7 = le7.filterDate(s, e).map(prepTM);
  var c8 = lc8.filterDate(s, e).map(prepOLI);
  var c9 = lc9.filterDate(s, e).map(prepOLI);

  // Склеиваем всё в одну коллекцию
  return c5.merge(c7).merge(c8).merge(c9);
}

// --- Годовой композит: медиана всех чистых пикселей за сезон, обрезанная по рамке ---
// Медиана «сшивает» перекрывающиеся сцены и убирает остатки облаков и полосы Landsat 7.
function annualComposite(year) {
  return seasonCollection(year)
    .median()
    .clip(aoi)
    .set('year', year);
}

// Параметры показа «естественных цветов»
var VIS_RGB = {bands: ['Red', 'Green', 'Blue'], min: 0.0, max: 0.25, gamma: 1.2};

// Добавляем на карту композиты проверочных лет.
// Включён только первый, остальные включайте галочками в окне Layers.
TEST_YEARS.forEach(function (y, i) {
  Map.addLayer(annualComposite(y), VIS_RGB, 'RGB ' + y, i === 0);
  print('Сцен в композите ' + y + ':', seasonCollection(y).size());
});
// =====================================================================
// ЭТАПЫ 4–5. ГОДОВЫЕ КОМПОЗИТЫ + ИНДЕКСЫ + ПРОСМОТРЩИК ПО ГОДАМ
//
// КАК ПОЛЬЗОВАТЬСЯ: вставьте этот код В КОНЕЦ вашего рабочего скрипта
// (после этапа 3, ничего не удаляя) и нажмите Run.
// Код использует то, что уже создано в этапах 1–3:
// aoi, rayon, ramka, lt5, le7, lc8, lc9, prepTM, prepOLI, START_YEAR и т.д.
// =====================================================================


// ---------------------------------------------------------------------
// НАСТРОЙКА: особые сезоны для «слабых» лет
// ---------------------------------------------------------------------
// По умолчанию все годы берутся за один и тот же сезон (июнь–сентябрь).
// Если какой-то год получится плохим (дыры, полосы), для него можно
// расширить окно. Формат: {год: [первый месяц, месяц ПОСЛЕ последнего]}.
// Пример для 2012 года (май–октябрь):  {2012: [5, 11]}
// Пока оставляем пустым и сначала смотрим на результат.
var SPECIAL_SEASONS = {};

function seasonMonths(year) {
  if (SPECIAL_SEASONS[year]) return SPECIAL_SEASONS[year];
  return [SEASON_START_MONTH, SEASON_END_MONTH];
}


// ---------------------------------------------------------------------
// ЭТАП 5 (функция). РАСЧЁТ ИНДЕКСОВ
// ---------------------------------------------------------------------
// normalizedDifference(['A','B']) считает (A − B) / (A + B)
function addIndices(img) {
  // Растительность / лес
  var ndvi = img.normalizedDifference(['NIR', 'Red']).rename('NDVI');
  var nbr = img.normalizedDifference(['NIR', 'SWIR2']).rename('NBR');    // вырубки, гари
  var ndmi = img.normalizedDifference(['NIR', 'SWIR1']).rename('NDMI');  // влажность растительности

  // Застройка
  var ndbi = img.normalizedDifference(['SWIR1', 'NIR']).rename('NDBI');
  var bui = ndbi.subtract(ndvi).rename('BUI');  // индекс застройки: NDBI минус NDVI

  // Вода
  var mndwi = img.normalizedDifference(['Green', 'SWIR1']).rename('MNDWI');  // основной
  var ndwi = img.normalizedDifference(['Green', 'NIR']).rename('NDWI');      // классический

  return img.addBands([ndvi, nbr, ndmi, ndbi, bui, mndwi, ndwi]);
}

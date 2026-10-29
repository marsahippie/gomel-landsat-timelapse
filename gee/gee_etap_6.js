// =====================================================================
// ЭТАП 6. КЛАССИФИКАЦИЯ RANDOM FOREST + ПЛОЩАДИ ПО ГОДАМ
//
// КАК ПОЛЬЗОВАТЬСЯ: вставьте этот код В КОНЕЦ вашего рабочего скрипта
// (после этапов 4–5, ничего не удаляя) и нажмите Run.
// Код использует: aoi, rayon, ramka, compositeByYear, START_YEAR, END_YEAR.
//
// Идея метода:
//  1) берём готовую карту земного покрова ESA WorldCover (2021, 10 м) —
//     по ней мы «объясняем» алгоритму, как выглядят застройка, лес, вода и т.д.
//  2) обучаем Random Forest на композите 2021 года (каналы + индексы);
//  3) проверяем точность на отложенной части выборки;
//  4) применяем обученный алгоритм к композиту КАЖДОГО года 1996–2026;
//  5) считаем площади классов по годам внутри границы района.
// =====================================================================


// ---------------------------------------------------------------------
// НАСТРОЙКИ
// ---------------------------------------------------------------------
var TRAIN_YEAR = 2021;          // год обучения (совпадает с картой WorldCover 2021)
var WORK_CRS = 'EPSG:32636';    // рабочая проекция (UTM 36N), единая для всех лет
var POINTS_PER_CLASS = 1500;    // сколько обучающих точек брать на каждый класс

// Наши 6 классов (коды 1–6) и их оформление
var CLASS_IDS = [1, 2, 3, 4, 5, 6];
var CLASS_NAMES = ['Застройка', 'Лес', 'Вода', 'Поля и луга', 'Голая почва и пески', 'Болота'];
var CLASS_COLORS = ['#d7191c', '#1a7a1a', '#2b83ba', '#f2e394', '#c9a66b', '#7fc4a8'];

// Признаки, по которым алгоритм различает классы: 6 каналов + 7 индексов
var FEATURES = ['Blue', 'Green', 'Red', 'NIR', 'SWIR1', 'SWIR2',
                'NDVI', 'NBR', 'NDMI', 'NDBI', 'BUI', 'MNDWI', 'NDWI'];


// ---------------------------------------------------------------------
// 6.1. ЭТАЛОННЫЕ МЕТКИ ИЗ ESA WORLDCOVER
// ---------------------------------------------------------------------
var worldcover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');

// Сводим 11 классов WorldCover к нашим шести:
//  10 лес -> 2 | 20 кустарник, 30 луг, 40 пашня -> 4 | 50 застройка -> 1
//  60 голая почва -> 5 | 80 вода -> 3 | 90 болото -> 6
var wcClass = worldcover
  .remap([10, 20, 30, 40, 50, 60, 80, 90], [2, 4, 4, 4, 1, 5, 3, 6])
  .rename('class');

// Оставляем только «чистые» места: где в окрестности ~30 м везде один и тот же класс.
// Так мы не обучаем алгоритм на смешанных пикселях у границ объектов.
var kern = {radius: 15, units: 'meters', kernelType: 'square'};
var pure = wcClass.focalMin(kern).eq(wcClass.focalMax(kern));
var labels = wcClass.updateMask(pure);


// ---------------------------------------------------------------------
// 6.2. ОБУЧАЮЩАЯ ВЫБОРКА
// ---------------------------------------------------------------------
var trainStack = compositeByYear[TRAIN_YEAR].select(FEATURES).addBands(labels);

// Стратифицированная выборка: одинаковое число точек на каждый класс
var classPoints = CLASS_IDS.map(function () { return POINTS_PER_CLASS; });

var sample = trainStack.stratifiedSample({
  numPoints: 0,
  classBand: 'class',
  region: aoi,
  scale: 30,
  projection: ee.Projection(WORK_CRS),
  seed: 42,
  classValues: CLASS_IDS,
  classPoints: classPoints,
  tileScale: 4,
  geometries: false
}).randomColumn('rnd', 42);

// 70% точек — для обучения, 30% — для проверки точности
var trainSet = sample.filter(ee.Filter.lt('rnd', 0.7));
var testSet = sample.filter(ee.Filter.gte('rnd', 0.7));

print('Точек в выборке:', sample.size());


// ---------------------------------------------------------------------
// 6.3. ОБУЧЕНИЕ И ПРОВЕРКА ТОЧНОСТИ
// ---------------------------------------------------------------------
var rf = ee.Classifier.smileRandomForest({numberOfTrees: 150, seed: 42}).train({
  features: trainSet,
  classProperty: 'class',
  inputProperties: FEATURES
});

// Применяем алгоритм к отложенным точкам и сравниваем с эталоном
var cm = testSet.classify(rf).errorMatrix('class', 'classification', CLASS_IDS);

print('Матрица ошибок (строки — эталон, столбцы — результат; порядок классов 1–6):', cm);
print('Общая точность:', cm.accuracy());
print('Каппа Коэна:', cm.kappa());
print('Точность по классам, «полнота» (producer):', cm.producersAccuracy());
print('Точность по классам, «достоверность» (user):', cm.consumersAccuracy());
print('Важность признаков:', ee.Dictionary(rf.explain()).get('importance'));


// ---------------------------------------------------------------------
// 6.4. КЛАССИФИКАЦИЯ ВСЕХ ЛЕТ
// ---------------------------------------------------------------------
var classifiedByYear = {};
var classifiedList = [];
for (var yy = START_YEAR; yy <= END_YEAR; yy++) {
  var comp = compositeByYear[yy];
  var cl = comp.select(FEATURES).classify(rf)
    .rename('class')
    .toByte()
    .set({year: yy, n_scenes: comp.get('n_scenes')});
  classifiedByYear[yy] = cl;
  classifiedList.push(cl);
}
var classifiedCollection = ee.ImageCollection.fromImages(classifiedList);


// ---------------------------------------------------------------------
// 6.5. ПРОСМОТРЩИК КЛАССИФИКАЦИИ (отдельная панель слева внизу)
// ---------------------------------------------------------------------
var CLASS_VIS = {min: 1, max: 6, palette: CLASS_COLORS};

// Слой классификации вставляем на позицию 1: над растром, но под контурами
Map.layers().insert(1, ui.Map.Layer(ee.Image(0).selfMask(), {}, 'Классификация'));

var clsSlider = ui.Slider({
  min: START_YEAR,
  max: END_YEAR,
  value: TRAIN_YEAR,
  step: 1,
  onChange: showClass,
  style: {stretch: 'horizontal'}
});

// Строка легенды: цветной квадратик + название класса
function legendRow(color, name) {
  return ui.Panel([
    ui.Label('', {backgroundColor: color, padding: '8px', margin: '0 6px 2px 0'}),
    ui.Label(name, {margin: '0 0 2px 0'})
  ], ui.Panel.Layout.flow('horizontal'));
}

var legendWidgets = [ui.Label('Классификация — год:', {fontWeight: 'bold'}), clsSlider];
CLASS_NAMES.forEach(function (name, i) {
  legendWidgets.push(legendRow(CLASS_COLORS[i], name));
});
Map.add(ui.Panel(legendWidgets, ui.Panel.Layout.flow('vertical'),
                 {position: 'bottom-left', width: '260px'}));

function showClass() {
  var year = clsSlider.getValue();
  Map.layers().set(1, ui.Map.Layer(classifiedByYear[year], CLASS_VIS, 'Классификация ' + year));
}
showClass();  // первый показ


// ---------------------------------------------------------------------
// 6.6. ПЛОЩАДИ КЛАССОВ ПО ГОДАМ (внутри границы района, км²)
// ---------------------------------------------------------------------
function areaFeature(cls) {
  var area = ee.Image.pixelArea().divide(1e6);   // площадь пикселя в км²

  // Для каждого класса: площадь там, где пиксель этого класса, иначе 0
  var bands = CLASS_IDS.map(function (k) {
    return area.multiply(cls.eq(k)).rename('c' + k);
  });
  // Площадь «без данных» (пиксели, где композит остался пустым) — для контроля
  bands.push(area.multiply(cls.mask().not()).rename('nodata'));

  var sums = ee.Image.cat(bands).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: rayon.geometry(),
    crs: WORK_CRS,
    scale: 30,
    maxPixels: 1e10,
    tileScale: 4
  });

  return ee.Feature(null, sums).set({
    year: cls.get('year'),
    n_scenes: cls.get('n_scenes')
  });
}

var stats = ee.FeatureCollection(classifiedCollection.map(areaFeature));

// Выгрузка таблицы в Google Drive (потом положим её в папку data на GitHub)
Export.table.toDrive({
  collection: stats,
  description: 'gomel_areas_by_class',
  folder: 'gomel_diplom',
  fileFormat: 'CSV',
  selectors: ['year', 'n_scenes', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'nodata']
});

// Графики. Расчёт может занять 1–3 минуты. Если появится ошибка
// «Computation timed out» — поставьте false и используйте только экспорт CSV.
var SHOW_CHART = true;

if (SHOW_CHART) {
  var seriesOpts = {};
  CLASS_IDS.forEach(function (k, i) {
    seriesOpts[i] = {labelInLegend: CLASS_NAMES[i], color: CLASS_COLORS[i]};
  });

  print(ui.Chart.feature.byFeature(stats, 'year', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
    .setChartType('LineChart')
    .setOptions({
      title: 'Площади классов в границах района, км²',
      hAxis: {title: 'Год', format: '####'},
      vAxis: {title: 'км²'},
      lineWidth: 2,
      pointSize: 3,
      series: seriesOpts
    }));

  // Отдельно застройка — чтобы её динамика была хорошо видна
  print(ui.Chart.feature.byFeature(stats, 'year', ['c1'])
    .setChartType('LineChart')
    .setOptions({
      title: 'Застройка, км²',
      hAxis: {title: 'Год', format: '####'},
      vAxis: {title: 'км²'},
      lineWidth: 2,
      pointSize: 3,
      colors: [CLASS_COLORS[0]],
      legend: {position: 'none'}
    }));
}
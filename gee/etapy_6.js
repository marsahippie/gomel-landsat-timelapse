// =====================================================================
// ЭТАП 6 (ВЕРСИЯ 2). КЛАССИФИКАЦИЯ ПО ЭПОХАМ + ПЛОЩАДИ ПО ГОДАМ
//
// КАК ПОЛЬЗОВАТЬСЯ:
//  1) В вашем скрипте оставьте всё до строки  showLayer();  // первый показ
//     (это конец этапов 4–5). ВСЁ, что ниже неё, удалите
//     (старый этап 6, диагностику и т.п.) и вставьте сюда этот код.
//  2) ПЕРВЫЙ запуск: SAMPLES_READY = false (как ниже). Нажмите Run.
//     Во вкладке Tasks появятся 2 задачи — запустите обе (кнопка Run) и
//     дождитесь завершения (несколько минут). В Assets появятся
//     samples_old и samples_new.
//  3) ВТОРОЙ запуск: поменяйте SAMPLES_READY на true, нажмите Save и Run.
//     Заработают обучение, карта, проверка точности и расчёт площадей.
//
// Идея: у Landsat 5/7 и Landsat 8/9 «цвета» немного разные, поэтому для
// 1996–2012 и для 2013–2026 обучаем ДВА разных классификатора.
// Обучающие метки берём только из «стабильных» мест, где класс почти
// наверняка не менялся (лес по Hansen, вода по JRC, застройка по GHSL),
// а не из карты 2021 года целиком.
// =====================================================================


// ---------------------------------------------------------------------
// НАСТРОЙКИ
// ---------------------------------------------------------------------
var SAMPLES_READY = false;   // false — шаг A (создаём выборки), true — шаг B (всё остальное)

var ASSET_OLD = 'projects/gomel-timelapse/assets/samples_old';
var ASSET_NEW = 'projects/gomel-timelapse/assets/samples_new';

var OLD_LAST_YEAR = 2012;                    // до этого года включительно — «старый» классификатор
var OLD_TRAIN_YEARS = [1998, 2002, 2006, 2010];   // годы для обучения старого классификатора
var NEW_TRAIN_YEARS = [2019, 2022, 2025];         // годы для обучения нового классификатора
var POINTS_PER_CLASS_PER_YEAR = 400;         // обучающих точек на класс в каждом году

var WORK_CRS = 'EPSG:32636';                 // единая рабочая проекция (UTM 36N)

// Четыре класса
var CLASS_IDS = [1, 2, 3, 4];
var CLASS_NAMES = ['Застройка', 'Лес', 'Вода', 'Прочее (поля, луга, болота, почва)'];
var CLASS_COLORS = ['#d7191c', '#1a7a1a', '#2b83ba', '#f2e394'];

// Признаки: 6 каналов + 7 индексов
var FEATURES = ['Blue', 'Green', 'Red', 'NIR', 'SWIR1', 'SWIR2',
                'NDVI', 'NBR', 'NDMI', 'NDBI', 'BUI', 'MNDWI', 'NDWI'];


// ---------------------------------------------------------------------
// ПОЛИГОН РАЙОНА (собираем из замкнутой линии; включает город Гомель)
// ---------------------------------------------------------------------
var rayonPoly = ee.Geometry.Polygon([rayon.geometry().coordinates()]);


// ---------------------------------------------------------------------
// ВНЕШНИЕ НАБОРЫ ДАННЫХ ДЛЯ «СТАБИЛЬНЫХ» МЕТОК
// ---------------------------------------------------------------------
var worldcover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');   // земной покров 2021
var hansen = ee.Image('UMD/hansen/global_forest_change_2025_v1_13');                // лес 2000–2024
var gsw = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');                                // поверхностные воды
var ghsl2020 = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_S/2020')
  .select('built_surface').divide(10000);   // доля застроенной площади в ячейке 100 м

// Строит картинку с метками классов 1–4 (в остальных местах метки нет)
//  builtYear — эпоха GHSL, по которой определяем «давнюю» застройку
function makeLabels(builtYear) {
  var treeCover2000 = hansen.select('treecover2000');
  var lossYear = hansen.select('lossyear');
  var gain = hansen.select('gain');
  var waterOcc = gsw.select('occurrence').unmask(0);
  var builtThen = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_S/' + builtYear)
    .select('built_surface').divide(10000);

  // 2 — Лес: густой лес в 2000 году, не вырублен и не вырос заново до 2024, и лес в 2021
  var forest = treeCover2000.gte(60).and(lossYear.eq(0)).and(gain.eq(0)).and(worldcover.eq(10));

  // 3 — Вода: вода почти всегда (по многолетним данным JRC)
  var water = waterOcc.gte(80);

  // 1 — Застройка: застроено уже в эпоху builtYear и застроено в 2021
  var built = builtThen.gte(0.35).and(worldcover.eq(50));

  // 4 — Прочее: поля, луга, кустарники, болота, голая почва — и не лес в 2000,
  //     и не будущая застройка, и никогда не вода
  var other = worldcover.eq(20).or(worldcover.eq(30)).or(worldcover.eq(40))
    .or(worldcover.eq(60)).or(worldcover.eq(90))
    .and(treeCover2000.lt(10))
    .and(gain.eq(0))
    .and(ghsl2020.lt(0.01))
    .and(waterOcc.lt(5));

  // Собираем в одну картинку. При пересечении побеждает вода, потом застройка, потом лес.
  var lab = ee.Image(0).where(other, 4).where(forest, 2).where(built, 1).where(water, 3);

  // Оставляем только «чистые» места: во всей окрестности ~30 м одна и та же метка
  var kern = {radius: 30, units: 'meters', kernelType: 'square'};
  var pure = lab.focalMin(kern).eq(lab.focalMax(kern));

  return lab.updateMask(lab.neq(0).and(pure)).rename('class');
}

var labelsOld = makeLabels(1990);   // для старой эпохи: застройка, существовавшая уже в 1990
var labelsNew = makeLabels(2020);   // для новой эпохи: застройка 2020 года


// ---------------------------------------------------------------------
// ШАГ A. СОЗДАНИЕ ОБУЧАЮЩИХ ВЫБОРОК (по нескольким годам каждой эпохи)
// ---------------------------------------------------------------------
function buildSamples(years, labels) {
  var classPoints = CLASS_IDS.map(function () { return POINTS_PER_CLASS_PER_YEAR; });
  var parts = years.map(function (yr) {
    return compositeByYear[yr].select(FEATURES).addBands(labels).stratifiedSample({
      numPoints: 0,
      classBand: 'class',
      region: aoi,
      scale: 30,
      projection: ee.Projection(WORK_CRS),
      seed: yr,
      classValues: CLASS_IDS,
      classPoints: classPoints,
      tileScale: 16,
      geometries: true
    }).map(function (f) { return f.set('year', yr); });
  });
  return ee.FeatureCollection(parts).flatten();
}


// ---------------------------------------------------------------------
// ШАГ B. ОБУЧЕНИЕ, КЛАССИФИКАЦИЯ, ПЛОЩАДИ
// ---------------------------------------------------------------------

// Обучает классификатор на выборке и печатает точность (30% точек — на проверку)
function trainEra(samples, eraName) {
  var withRnd = samples.randomColumn('rnd', 42);
  var trainSet = withRnd.filter(ee.Filter.lt('rnd', 0.7));
  var testSet = withRnd.filter(ee.Filter.gte('rnd', 0.7));

  var rf = ee.Classifier.smileRandomForest({numberOfTrees: 150, seed: 42}).train({
    features: trainSet,
    classProperty: 'class',
    inputProperties: FEATURES
  });

  var cm = testSet.classify(rf).errorMatrix('class', 'classification', CLASS_IDS);
  print('— ' + eraName + ' — точек в выборке:', samples.size());
  print(eraName + ': матрица ошибок (строки — эталон, столбцы — результат, классы 1–4):', cm);
  print(eraName + ': общая точность:', cm.accuracy());
  print(eraName + ': каппа Коэна:', cm.kappa());
  print(eraName + ': полнота по классам:', cm.producersAccuracy());
  print(eraName + ': достоверность по классам:', cm.consumersAccuracy());
  return rf;
}

// Площади классов (км²) внутри полигона района для одного классифицированного изображения
function areaFeature(cls) {
  var area = ee.Image.pixelArea().divide(1e6);   // площадь пикселя в км²
  var bands = CLASS_IDS.map(function (k) {
    return area.multiply(cls.eq(k)).rename('c' + k);
  });
  bands.push(area.multiply(cls.mask().not()).rename('nodata'));  // пиксели без данных — для контроля

  var sums = ee.Image.cat(bands).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: rayonPoly,
    crs: WORK_CRS,
    scale: 30,
    maxPixels: 1e10,
    tileScale: 4
  });

  return ee.Feature(null, sums).set({
    year: cls.get('year'),
    n_scenes: cls.get('n_scenes'),
    clf: cls.get('clf')
  });
}

function runMain() {
  // 1. Загружаем готовые выборки и обучаем два классификатора
  var samplesOld = ee.FeatureCollection(ASSET_OLD);
  var samplesNew = ee.FeatureCollection(ASSET_NEW);
  var rfOld = trainEra(samplesOld, 'СТАРАЯ ЭПОХА (Landsat 5/7)');
  var rfNew = trainEra(samplesNew, 'НОВАЯ ЭПОХА (Landsat 7/8/9)');

  // 2. Классифицируем все годы: до OLD_LAST_YEAR — старым, дальше — новым
  var classifiedByYear = {};
  var classifiedList = [];
  for (var yr = START_YEAR; yr <= END_YEAR; yr++) {
    var comp = compositeByYear[yr];
    var useOld = (yr <= OLD_LAST_YEAR);
    var cl = comp.select(FEATURES).classify(useOld ? rfOld : rfNew)
      .rename('class')
      .toByte()
      .set({year: yr, n_scenes: comp.get('n_scenes'), clf: useOld ? 'old' : 'new'});
    classifiedByYear[yr] = cl;
    classifiedList.push(cl);
  }
  var classifiedCollection = ee.ImageCollection.fromImages(classifiedList);

  // 3. Просмотрщик классификации (панель слева внизу)
  var CLASS_VIS = {min: 1, max: 4, palette: CLASS_COLORS};

  // Слой классификации — на позиции 1: над растром, но под контурами
  Map.layers().insert(1, ui.Map.Layer(ee.Image(0).selfMask(), {}, 'Классификация'));

  var clsSlider = ui.Slider({
    min: START_YEAR,
    max: END_YEAR,
    value: 2021,
    step: 1,
    onChange: showClass,
    style: {stretch: 'horizontal'}
  });

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
                   {position: 'bottom-left', width: '300px'}));

  function showClass() {
    var year = clsSlider.getValue();
    Map.layers().set(1, ui.Map.Layer(classifiedByYear[year], CLASS_VIS, 'Классификация ' + year));
  }
  showClass();

  // 4. Проверка «стыка» эпох: классифицируем 2012 и 2013 годы ОБОИМИ классификаторами.
  //    Если площади сильно различаются, значит смена датчика даёт искусственный скачок.
  function overlapImage(year, rf, label) {
    return compositeByYear[year].select(FEATURES).classify(rf)
      .rename('class').toByte()
      .set({year: year, n_scenes: compositeByYear[year].get('n_scenes'), clf: label});
  }
  var overlap = ee.FeatureCollection([
    areaFeature(overlapImage(2012, rfOld, 'old')),
    areaFeature(overlapImage(2012, rfNew, 'new')),
    areaFeature(overlapImage(2013, rfOld, 'old')),
    areaFeature(overlapImage(2013, rfNew, 'new'))
  ]);
  print('Проверка стыка эпох: площади классов (км²), классификатор old/new на 2012 и 2013:', overlap);

  // 5. Площади по годам -> таблица CSV на Google Drive
  var stats = ee.FeatureCollection(classifiedCollection.map(areaFeature));

  Export.table.toDrive({
    collection: stats,
    description: 'gomel_areas_by_class_v2',
    folder: 'gomel_diplom',
    fileFormat: 'CSV',
    selectors: ['year', 'clf', 'n_scenes', 'c1', 'c2', 'c3', 'c4', 'nodata']
  });

  // График площадей. Расчёт тяжёлый: включайте только если нужно (может быть
  // ошибка «Computation timed out» — тогда пользуйтесь таблицей CSV).
  var SHOW_CHART = false;
  if (SHOW_CHART) {
    var seriesOpts = {};
    CLASS_IDS.forEach(function (k, i) {
      seriesOpts[i] = {labelInLegend: CLASS_NAMES[i], color: CLASS_COLORS[i]};
    });
    print(ui.Chart.feature.byFeature(stats, 'year', ['c1', 'c2', 'c3', 'c4'])
      .setChartType('LineChart')
      .setOptions({
        title: 'Площади классов в границах района, км²',
        hAxis: {title: 'Год', format: '####'},
        vAxis: {title: 'км²'},
        lineWidth: 2,
        pointSize: 3,
        series: seriesOpts
      }));
  }

  print('Площадь полигона района, км²:', rayonPoly.area(1).divide(1e6));
}


// ---------------------------------------------------------------------
// ЗАПУСК
// ---------------------------------------------------------------------
if (!SAMPLES_READY) {
  // ШАГ A: создаём две задачи экспорта в Assets
  Export.table.toAsset({
    collection: buildSamples(OLD_TRAIN_YEARS, labelsOld),
    description: 'samples_old',
    assetId: ASSET_OLD
  });
  Export.table.toAsset({
    collection: buildSamples(NEW_TRAIN_YEARS, labelsNew),
    description: 'samples_new',
    assetId: ASSET_NEW
  });
  print('ШАГ A: во вкладке Tasks запустите задачи samples_old и samples_new (кнопка Run).');
  print('Когда обе завершатся, поставьте SAMPLES_READY = true, нажмите Save и Run.');
} else {
  runMain();
}

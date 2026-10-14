// GTFS / GTFS-Flex / GTFS-JP のファイルと列の定義。
// 仕様が変わったら、ここを直すだけで 表編集・フォーム・検証 の全部に反映される。
//
// 列の type:
//   id      文字列 ID            text   自由文        url   http(s) の URL     email  メール
//   phone   電話番号             int    0 以上の整数   float 数値             lat/lon 緯度/経度
//   date    YYYYMMDD             time   HH:MM:SS      enum  values のどれか   ref    他ファイルの ID（ref: 'stops.txt'）
//   color   6 桁 16 進           tz     タイムゾーン   lang  言語コード
// required: true（必須）/ false（任意）/ 'cond'（条件付き。条件の検証は validate.js の規則で行う）
// 列定義にない列が来ても、そのまま保持して書き出す。
(function () {
  'use strict';

  const PICKUP = { '0': '0: 通常どおり乗車', '1': '1: 乗車できない', '2': '2: 事業者に連絡して乗車', '3': '3: 運転士に合図して乗車' };
  const DROPOFF = { '0': '0: 通常どおり降車', '1': '1: 降車できない', '2': '2: 事業者に連絡して降車', '3': '3: 運転士に合図して降車' };
  const YESNO = { '0': '0: いいえ', '1': '1: はい' };

  const FILES = {
    'agency.txt': {
      label: '事業者', presence: 'required', key: 'agency_id',
      fields: [
        { name: 'agency_id', label: '事業者ID', type: 'id', required: 'cond' },
        { name: 'agency_name', label: '事業者名', type: 'text', required: true },
        { name: 'agency_url', label: 'URL', type: 'url', required: true },
        { name: 'agency_timezone', label: 'タイムゾーン', type: 'tz', required: true, default: 'Asia/Tokyo' },
        { name: 'agency_lang', label: '言語', type: 'lang', default: 'ja' },
        { name: 'agency_phone', label: '電話番号', type: 'phone' },
        { name: 'agency_fare_url', label: '運賃URL', type: 'url' },
        { name: 'agency_email', label: 'メール', type: 'email' },
      ],
    },
    'stops.txt': {
      label: '停留所', presence: 'cond', key: 'stop_id',
      fields: [
        { name: 'stop_id', label: '停留所ID', type: 'id', required: true },
        { name: 'stop_code', label: '番号', type: 'text' },
        { name: 'stop_name', label: '停留所名', type: 'text', required: 'cond' },
        { name: 'stop_desc', label: '説明', type: 'text' },
        { name: 'stop_lat', label: '緯度', type: 'lat', required: 'cond' },
        { name: 'stop_lon', label: '経度', type: 'lon', required: 'cond' },
        { name: 'zone_id', label: '運賃ゾーン', type: 'text' },
        { name: 'stop_url', label: 'URL', type: 'url' },
        { name: 'location_type', label: '種別', type: 'enum', values: { '0': '0: 停留所', '1': '1: 駅', '2': '2: 出入口', '3': '3: 構内の点', '4': '4: 乗車位置' } },
        { name: 'parent_station', label: '親の駅', type: 'ref', ref: 'stops.txt' },
        { name: 'stop_timezone', label: 'タイムゾーン', type: 'tz' },
        { name: 'wheelchair_boarding', label: '車いす', type: 'enum', values: { '0': '0: 情報なし', '1': '1: 可', '2': '2: 不可' } },
        { name: 'platform_code', label: 'のりば', type: 'text' },
        { name: 'tts_stop_name', label: '読み上げ用の名前', type: 'text' },
        { name: 'level_id', label: '階', type: 'ref', ref: 'levels.txt' },
        { name: 'platform_name', label: 'のりば名 (JP)', type: 'text' },
      ],
    },
    'routes.txt': {
      label: '路線', presence: 'required', key: 'route_id',
      fields: [
        { name: 'route_id', label: '路線ID', type: 'id', required: true },
        { name: 'agency_id', label: '事業者ID', type: 'ref', ref: 'agency.txt', required: 'cond' },
        { name: 'route_short_name', label: '短い名前', type: 'text', required: 'cond' },
        { name: 'route_long_name', label: '長い名前', type: 'text', required: 'cond' },
        { name: 'route_desc', label: '説明', type: 'text' },
        { name: 'route_type', label: '種別', type: 'enum', required: true, values: { '3': '3: バス', '715': '715: デマンド交通（拡張）', '700': '700: バス（拡張）', '0': '0: 路面電車', '1': '1: 地下鉄', '2': '2: 鉄道', '4': '4: フェリー', '5': '5: ケーブルカー', '6': '6: ロープウェイ', '7': '7: ケーブル鉄道', '11': '11: トロリーバス', '12': '12: モノレール' }, default: '3' },
        { name: 'route_url', label: 'URL', type: 'url' },
        { name: 'route_color', label: '色', type: 'color' },
        { name: 'route_text_color', label: '文字色', type: 'color' },
        { name: 'route_sort_order', label: '並び順', type: 'int' },
        { name: 'continuous_pickup', label: '途中乗車', type: 'enum', values: PICKUP },
        { name: 'continuous_drop_off', label: '途中降車', type: 'enum', values: DROPOFF },
        { name: 'network_id', label: 'ネットワークID', type: 'text' },
        { name: 'jp_parent_route_id', label: '親路線ID (JP)', type: 'text' },
      ],
    },
    'trips.txt': {
      label: '便', presence: 'required', key: 'trip_id',
      fields: [
        { name: 'route_id', label: '路線ID', type: 'ref', ref: 'routes.txt', required: true },
        { name: 'service_id', label: '運行日ID', type: 'ref', ref: 'calendar', required: true },
        { name: 'trip_id', label: '便ID', type: 'id', required: true },
        { name: 'trip_headsign', label: '行き先表示', type: 'text' },
        { name: 'trip_short_name', label: '便名', type: 'text' },
        { name: 'direction_id', label: '方向', type: 'enum', values: { '0': '0: 往路', '1': '1: 復路' } },
        { name: 'block_id', label: '車両運用ID', type: 'text' },
        { name: 'shape_id', label: '経路形状ID', type: 'text' },
        { name: 'wheelchair_accessible', label: '車いす', type: 'enum', values: { '0': '0: 情報なし', '1': '1: 可', '2': '2: 不可' } },
        { name: 'bikes_allowed', label: '自転車', type: 'enum', values: { '0': '0: 情報なし', '1': '1: 可', '2': '2: 不可' } },
        { name: 'cars_allowed', label: '車両の積載', type: 'enum', values: { '0': '0: 情報なし', '1': '1: 可', '2': '2: 不可' } },
        { name: 'jp_trip_desc', label: '便の説明 (JP)', type: 'text' },
        { name: 'jp_trip_desc_symbol', label: '記号 (JP)', type: 'text' },
        { name: 'jp_office_id', label: '営業所ID (JP)', type: 'text' },
        { name: 'jp_pattern_id', label: '系統ID (JP)', type: 'text' },
      ],
    },
    'stop_times.txt': {
      label: '便の時刻・乗降時間帯', presence: 'required', key: null,
      fields: [
        { name: 'trip_id', label: '便ID', type: 'ref', ref: 'trips.txt', required: true },
        { name: 'arrival_time', label: '到着時刻', type: 'time', required: 'cond' },
        { name: 'departure_time', label: '出発時刻', type: 'time', required: 'cond' },
        { name: 'stop_id', label: '停留所ID', type: 'ref', ref: 'stops.txt', required: 'cond' },
        { name: 'location_group_id', label: '停留所グループID', type: 'ref', ref: 'location_groups.txt', required: 'cond' },
        { name: 'location_id', label: '区域ID', type: 'ref', ref: 'locations.geojson', required: 'cond' },
        { name: 'stop_sequence', label: '順番', type: 'int', required: true },
        { name: 'stop_headsign', label: '行き先表示', type: 'text' },
        { name: 'start_pickup_drop_off_window', label: '乗降時間帯 開始', type: 'time', required: 'cond' },
        { name: 'end_pickup_drop_off_window', label: '乗降時間帯 終了', type: 'time', required: 'cond' },
        { name: 'pickup_type', label: '乗車', type: 'enum', values: PICKUP },
        { name: 'drop_off_type', label: '降車', type: 'enum', values: DROPOFF },
        { name: 'continuous_pickup', label: '途中乗車', type: 'enum', values: PICKUP },
        { name: 'continuous_drop_off', label: '途中降車', type: 'enum', values: DROPOFF },
        { name: 'shape_dist_traveled', label: '距離', type: 'float' },
        { name: 'timepoint', label: '時刻の正確さ', type: 'enum', values: { '0': '0: おおよそ', '1': '1: 正確' } },
        { name: 'pickup_booking_rule_id', label: '乗車の予約ルール', type: 'ref', ref: 'booking_rules.txt' },
        { name: 'drop_off_booking_rule_id', label: '降車の予約ルール', type: 'ref', ref: 'booking_rules.txt' },
      ],
    },
    'calendar.txt': {
      label: '運行曜日', presence: 'cond', key: 'service_id',
      fields: [
        { name: 'service_id', label: '運行日ID', type: 'id', required: true },
        { name: 'monday', label: '月', type: 'enum', values: YESNO, required: true },
        { name: 'tuesday', label: '火', type: 'enum', values: YESNO, required: true },
        { name: 'wednesday', label: '水', type: 'enum', values: YESNO, required: true },
        { name: 'thursday', label: '木', type: 'enum', values: YESNO, required: true },
        { name: 'friday', label: '金', type: 'enum', values: YESNO, required: true },
        { name: 'saturday', label: '土', type: 'enum', values: YESNO, required: true },
        { name: 'sunday', label: '日', type: 'enum', values: YESNO, required: true },
        { name: 'start_date', label: '開始日', type: 'date', required: true },
        { name: 'end_date', label: '終了日', type: 'date', required: true },
      ],
    },
    'calendar_dates.txt': {
      label: '運行日の例外', presence: 'cond', key: null,
      fields: [
        { name: 'service_id', label: '運行日ID', type: 'id', required: true },
        { name: 'date', label: '日付', type: 'date', required: true },
        { name: 'exception_type', label: '種別', type: 'enum', values: { '1': '1: この日は運行', '2': '2: この日は運休' }, required: true },
      ],
    },
    'booking_rules.txt': {
      label: '予約ルール', presence: 'optional', key: 'booking_rule_id',
      fields: [
        { name: 'booking_rule_id', label: '予約ルールID', type: 'id', required: true },
        { name: 'booking_type', label: '予約の種類', type: 'enum', required: true, values: { '0': '0: 予約なしで乗れる', '1': '1: 当日に予約（○分前まで）', '2': '2: 前日までに予約' } },
        { name: 'prior_notice_duration_min', label: '最短 ○分前まで', type: 'int', required: 'cond', help: 'booking_type=1 で必須。乗車の何分前までに予約するか' },
        { name: 'prior_notice_duration_max', label: '最長 ○分前から', type: 'int', help: 'booking_type=1 のみ。何分前から予約できるか' },
        { name: 'prior_notice_last_day', label: '最短 ○日前まで', type: 'int', required: 'cond', help: 'booking_type=2 で必須。前日なら 1' },
        { name: 'prior_notice_last_time', label: '最短 その日の○時まで', type: 'time', required: 'cond', help: 'last_day とセット' },
        { name: 'prior_notice_start_day', label: '最長 ○日前から', type: 'int', help: '何日前から予約できるか' },
        { name: 'prior_notice_start_time', label: '最長 その日の○時から', type: 'time', required: 'cond', help: 'start_day とセット' },
        { name: 'prior_notice_service_id', label: '予約受付日の運行日ID', type: 'ref', ref: 'calendar', help: 'booking_type=2 のみ' },
        { name: 'message', label: '案内文', type: 'text' },
        { name: 'pickup_message', label: '乗車の案内文', type: 'text' },
        { name: 'drop_off_message', label: '降車の案内文', type: 'text' },
        { name: 'phone_number', label: '予約電話番号', type: 'phone' },
        { name: 'info_url', label: '案内URL', type: 'url' },
        { name: 'booking_url', label: '予約URL', type: 'url' },
      ],
    },
    'location_groups.txt': {
      label: '停留所グループ（区域）', presence: 'optional', key: 'location_group_id',
      fields: [
        { name: 'location_group_id', label: 'グループID', type: 'id', required: true },
        { name: 'location_group_name', label: 'グループ名', type: 'text' },
      ],
    },
    'location_group_stops.txt': {
      label: 'グループの停留所', presence: 'optional', key: null,
      fields: [
        { name: 'location_group_id', label: 'グループID', type: 'ref', ref: 'location_groups.txt', required: true },
        { name: 'stop_id', label: '停留所ID', type: 'ref', ref: 'stops.txt', required: true },
      ],
    },
    'feed_info.txt': {
      label: 'データ情報', presence: 'cond', key: null,
      fields: [
        { name: 'feed_publisher_name', label: '公開者', type: 'text', required: true },
        { name: 'feed_publisher_url', label: '公開者URL', type: 'url', required: true },
        { name: 'feed_lang', label: '言語', type: 'lang', required: true, default: 'ja' },
        { name: 'default_lang', label: '既定の言語', type: 'lang' },
        { name: 'feed_start_date', label: '有効開始日', type: 'date' },
        { name: 'feed_end_date', label: '有効終了日', type: 'date' },
        { name: 'feed_version', label: '版', type: 'text' },
        { name: 'feed_contact_email', label: '連絡先メール', type: 'email' },
        { name: 'feed_contact_url', label: '連絡先URL', type: 'url' },
      ],
    },
    'shapes.txt': { label: '経路形状', presence: 'optional', key: null, fields: [
      { name: 'shape_id', label: '形状ID', type: 'id', required: true }, { name: 'shape_pt_lat', label: '緯度', type: 'lat', required: true }, { name: 'shape_pt_lon', label: '経度', type: 'lon', required: true }, { name: 'shape_pt_sequence', label: '順番', type: 'int', required: true }, { name: 'shape_dist_traveled', label: '距離', type: 'float' } ] },
    'frequencies.txt': { label: '運転間隔', presence: 'optional', key: null, fields: [
      { name: 'trip_id', label: '便ID', type: 'ref', ref: 'trips.txt', required: true }, { name: 'start_time', label: '開始', type: 'time', required: true }, { name: 'end_time', label: '終了', type: 'time', required: true }, { name: 'headway_secs', label: '間隔(秒)', type: 'int', required: true }, { name: 'exact_times', label: '正確', type: 'enum', values: YESNO } ] },
    'fare_attributes.txt': { label: '運賃', presence: 'optional', key: 'fare_id', fields: [
      { name: 'fare_id', label: '運賃ID', type: 'id', required: true }, { name: 'price', label: '金額', type: 'float', required: true }, { name: 'currency_type', label: '通貨', type: 'text', required: true, default: 'JPY' }, { name: 'payment_method', label: '支払い', type: 'enum', values: { '0': '0: 車内', '1': '1: 乗車前' }, required: true }, { name: 'transfers', label: '乗継', type: 'enum', values: { '0': '0: 不可', '1': '1: 1回', '2': '2: 2回', '': '無制限' }, required: true }, { name: 'agency_id', label: '事業者ID', type: 'ref', ref: 'agency.txt' }, { name: 'transfer_duration', label: '乗継時間(秒)', type: 'int' } ] },
    'fare_rules.txt': { label: '運賃の適用', presence: 'optional', key: null, fields: [
      { name: 'fare_id', label: '運賃ID', type: 'ref', ref: 'fare_attributes.txt', required: true }, { name: 'route_id', label: '路線ID', type: 'ref', ref: 'routes.txt' }, { name: 'origin_id', label: '乗車ゾーン', type: 'text' }, { name: 'destination_id', label: '降車ゾーン', type: 'text' }, { name: 'contains_id', label: '経由ゾーン', type: 'text' } ] },
    'translations.txt': { label: '翻訳', presence: 'optional', key: null, fields: [
      { name: 'table_name', label: '表', type: 'text', required: true }, { name: 'field_name', label: '列', type: 'text', required: true }, { name: 'language', label: '言語', type: 'lang', required: true }, { name: 'translation', label: '訳', type: 'text', required: true }, { name: 'record_id', label: 'レコードID', type: 'text' }, { name: 'record_sub_id', label: 'サブID', type: 'text' }, { name: 'field_value', label: '元の値', type: 'text' } ] },
    'attributions.txt': { label: '帰属', presence: 'optional', key: null, fields: [
      { name: 'attribution_id', label: 'ID', type: 'id' }, { name: 'agency_id', label: '事業者ID', type: 'ref', ref: 'agency.txt' }, { name: 'route_id', label: '路線ID', type: 'ref', ref: 'routes.txt' }, { name: 'trip_id', label: '便ID', type: 'ref', ref: 'trips.txt' }, { name: 'organization_name', label: '組織名', type: 'text', required: true }, { name: 'is_producer', label: '作成者', type: 'enum', values: YESNO }, { name: 'is_operator', label: '運行者', type: 'enum', values: YESNO }, { name: 'is_authority', label: '許認可', type: 'enum', values: YESNO }, { name: 'attribution_url', label: 'URL', type: 'url' }, { name: 'attribution_email', label: 'メール', type: 'email' }, { name: 'attribution_phone', label: '電話', type: 'phone' } ] },
    'transfers.txt': { label: '乗継', presence: 'optional', key: null, fields: [
      { name: 'from_stop_id', label: '乗継元', type: 'ref', ref: 'stops.txt' }, { name: 'to_stop_id', label: '乗継先', type: 'ref', ref: 'stops.txt' }, { name: 'from_route_id', label: '元路線', type: 'ref', ref: 'routes.txt' }, { name: 'to_route_id', label: '先路線', type: 'ref', ref: 'routes.txt' }, { name: 'from_trip_id', label: '元便', type: 'ref', ref: 'trips.txt' }, { name: 'to_trip_id', label: '先便', type: 'ref', ref: 'trips.txt' }, { name: 'transfer_type', label: '種別', type: 'enum', values: { '0': '0: 推奨', '1': '1: 待ち合わせ', '2': '2: 最低時間', '3': '3: 不可', '4': '4: 同一車両', '5': '5: 降車必要' }, required: true }, { name: 'min_transfer_time', label: '最低時間(秒)', type: 'int' } ] },
    'office_jp.txt': { label: '営業所 (JP)', presence: 'optional', key: 'office_id', fields: [
      { name: 'office_id', label: '営業所ID', type: 'id', required: true }, { name: 'office_name', label: '営業所名', type: 'text', required: true }, { name: 'office_url', label: 'URL', type: 'url' }, { name: 'office_phone', label: '電話', type: 'phone' } ] },
    'pattern_jp.txt': { label: '系統 (JP)', presence: 'optional', key: 'jp_pattern_id', fields: [
      { name: 'jp_pattern_id', label: '系統ID', type: 'id', required: true }, { name: 'jp_pattern_name', label: '系統名', type: 'text' }, { name: 'jp_pattern_no', label: '系統番号', type: 'text' }, { name: 'jp_origin_stop_id', label: '起点', type: 'ref', ref: 'stops.txt' }, { name: 'jp_destination_stop_id', label: '終点', type: 'ref', ref: 'stops.txt' } ] },
    'routes_jp.txt': { label: '路線補足 (JP)', presence: 'optional', key: null, fields: [
      { name: 'route_id', label: '路線ID', type: 'ref', ref: 'routes.txt', required: true }, { name: 'route_update_date', label: '更新日', type: 'date' }, { name: 'origin_stop', label: '起点', type: 'text' }, { name: 'via_stop', label: '経由', type: 'text' }, { name: 'destination_stop', label: '終点', type: 'text' } ] },
    'agency_jp.txt': { label: '事業者追加情報 (JP)', presence: 'optional', key: null, fields: [
      { name: 'agency_id', label: '事業者ID', type: 'ref', ref: 'agency.txt', required: true }, { name: 'agency_official_name', label: '正式名称', type: 'text' }, { name: 'agency_zip_number', label: '郵便番号', type: 'text' }, { name: 'agency_address', label: '住所', type: 'text' }, { name: 'agency_president_pos', label: '代表者役職', type: 'text' }, { name: 'agency_president_name', label: '代表者名', type: 'text' } ] },
    // ---- 駅構内（Pathways）----
    'levels.txt': { label: '階', presence: 'optional', key: 'level_id', fields: [
      { name: 'level_id', label: '階ID', type: 'id', required: true }, { name: 'level_index', label: '階の順序', type: 'float', required: true }, { name: 'level_name', label: '階の名前', type: 'text' } ] },
    'pathways.txt': { label: '構内経路', presence: 'optional', key: 'pathway_id', fields: [
      { name: 'pathway_id', label: '経路ID', type: 'id', required: true }, { name: 'from_stop_id', label: '始点', type: 'ref', ref: 'stops.txt', required: true }, { name: 'to_stop_id', label: '終点', type: 'ref', ref: 'stops.txt', required: true },
      { name: 'pathway_mode', label: '種類', type: 'enum', required: true, values: { '1': '1: 通路', '2': '2: 階段', '3': '3: 動く歩道', '4': '4: エスカレーター', '5': '5: エレベーター', '6': '6: 改札', '7': '7: 出場改札' } },
      { name: 'is_bidirectional', label: '双方向', type: 'enum', required: true, values: { '0': '0: 一方向', '1': '1: 双方向' } }, { name: 'length', label: '長さ(m)', type: 'float' }, { name: 'traversal_time', label: '所要秒', type: 'int' }, { name: 'stair_count', label: '段数', type: 'int' }, { name: 'max_slope', label: '最大勾配', type: 'float' }, { name: 'min_width', label: '最小幅(m)', type: 'float' }, { name: 'signposted_as', label: '案内表示', type: 'text' }, { name: 'reversed_signposted_as', label: '逆向きの案内表示', type: 'text' } ] },
    // ---- 運賃 v2 ----
    'fare_media.txt': { label: '運賃媒体', presence: 'optional', key: 'fare_media_id', fields: [
      { name: 'fare_media_id', label: '媒体ID', type: 'id', required: true }, { name: 'fare_media_name', label: '媒体名', type: 'text' }, { name: 'fare_media_type', label: '種類', type: 'enum', required: true, values: { '0': '0: なし（現金）', '1': '1: 紙券', '2': '2: 交通系 IC', '3': '3: クレジット等', '4': '4: アプリ' } } ] },
    'rider_categories.txt': { label: '利用者区分', presence: 'optional', key: 'rider_category_id', fields: [
      { name: 'rider_category_id', label: '区分ID', type: 'id', required: true }, { name: 'rider_category_name', label: '区分名', type: 'text', required: true }, { name: 'is_default_fare_category', label: '既定', type: 'enum', required: true, values: { '0': '0: いいえ', '1': '1: はい' } }, { name: 'eligibility_url', label: '条件URL', type: 'url' } ] },
    'fare_products.txt': { label: '運賃商品', presence: 'optional', key: null, fields: [
      { name: 'fare_product_id', label: '商品ID', type: 'id', required: true }, { name: 'fare_product_name', label: '商品名', type: 'text' }, { name: 'rider_category_id', label: '利用者区分', type: 'ref', ref: 'rider_categories.txt' }, { name: 'fare_media_id', label: '媒体', type: 'ref', ref: 'fare_media.txt' }, { name: 'amount', label: '金額', type: 'float', required: true }, { name: 'currency', label: '通貨', type: 'text', required: true, default: 'JPY' } ] },
    'fare_leg_rules.txt': { label: '区間運賃', presence: 'optional', key: null, fields: [
      { name: 'leg_group_id', label: '区間グループ', type: 'text' }, { name: 'network_id', label: 'ネットワーク', type: 'text' }, { name: 'from_area_id', label: '乗車エリア', type: 'ref', ref: 'areas.txt' }, { name: 'to_area_id', label: '降車エリア', type: 'ref', ref: 'areas.txt' }, { name: 'from_timeframe_group_id', label: '乗車時間帯', type: 'text' }, { name: 'to_timeframe_group_id', label: '降車時間帯', type: 'text' }, { name: 'fare_product_id', label: '商品', type: 'text', required: true }, { name: 'rule_priority', label: '優先度', type: 'int' } ] },
    'fare_leg_join_rules.txt': { label: '区間の結合', presence: 'optional', key: null, fields: [
      { name: 'from_network_id', label: '元ネットワーク', type: 'text', required: true }, { name: 'to_network_id', label: '先ネットワーク', type: 'text', required: true }, { name: 'from_stop_id', label: '元停留所', type: 'ref', ref: 'stops.txt' }, { name: 'to_stop_id', label: '先停留所', type: 'ref', ref: 'stops.txt' } ] },
    'fare_transfer_rules.txt': { label: '乗継運賃', presence: 'optional', key: null, fields: [
      { name: 'from_leg_group_id', label: '元区間グループ', type: 'text' }, { name: 'to_leg_group_id', label: '先区間グループ', type: 'text' }, { name: 'transfer_count', label: '乗継回数', type: 'int' }, { name: 'duration_limit', label: '時間制限(秒)', type: 'int' }, { name: 'duration_limit_type', label: '時間の数え方', type: 'enum', values: { '0': '0', '1': '1', '2': '2', '3': '3' } }, { name: 'fare_transfer_type', label: '計算方法', type: 'enum', required: true, values: { '0': '0: A+AB', '1': '1: A+AB+B', '2': '2: AB' } }, { name: 'fare_product_id', label: '商品', type: 'text' } ] },
    'areas.txt': { label: '運賃エリア', presence: 'optional', key: 'area_id', fields: [
      { name: 'area_id', label: 'エリアID', type: 'id', required: true }, { name: 'area_name', label: 'エリア名', type: 'text' } ] },
    'stop_areas.txt': { label: 'エリアの停留所', presence: 'optional', key: null, fields: [
      { name: 'area_id', label: 'エリアID', type: 'ref', ref: 'areas.txt', required: true }, { name: 'stop_id', label: '停留所ID', type: 'ref', ref: 'stops.txt', required: true } ] },
    'networks.txt': { label: 'ネットワーク', presence: 'optional', key: 'network_id', fields: [
      { name: 'network_id', label: 'ネットワークID', type: 'id', required: true }, { name: 'network_name', label: '名前', type: 'text' } ] },
    'route_networks.txt': { label: '路線のネットワーク', presence: 'optional', key: null, fields: [
      { name: 'network_id', label: 'ネットワークID', type: 'ref', ref: 'networks.txt', required: true }, { name: 'route_id', label: '路線ID', type: 'ref', ref: 'routes.txt', required: true } ] },
    'timeframes.txt': { label: '運賃の時間帯', presence: 'optional', key: null, fields: [
      { name: 'timeframe_group_id', label: '時間帯グループ', type: 'id', required: true }, { name: 'start_time', label: '開始', type: 'time' }, { name: 'end_time', label: '終了', type: 'time' }, { name: 'service_id', label: '運行日ID', type: 'ref', ref: 'calendar', required: true } ] },
  };

  // locations.geojson（Flex の区域ポリゴン）の properties
  const LOCATION_PROPS = [
    { name: 'stop_name', label: '区域名', type: 'text' },
    { name: 'stop_desc', label: '説明', type: 'text' },
    { name: 'zone_id', label: '運賃ゾーン', type: 'text' },
    { name: 'stop_url', label: 'URL', type: 'url' },
  ];

  // 画面に出す順
  const ORDER = Object.keys(FILES);

  // 旧形式との互換（gtfs.js / validate.js が使う簡易形）
  const SPEC = {};
  for (const [name, f] of Object.entries(FILES)) {
    SPEC[name] = { key: f.key, cols: f.fields.map(x => x.name), required: f.fields.filter(x => x.required === true).map(x => x.name), label: f.label, presence: f.presence, fields: f.fields };
  }

  function field(file, col) { return FILES[file] ? FILES[file].fields.find(x => x.name === col) : null; }
  function label(file, col) { const f = field(file, col); return f ? f.label : col; }

  window.FLEX_SPEC = { FILES, SPEC, ORDER, LOCATION_PROPS, field, label, version: 'GTFS Schedule（Flex 採択後）+ GTFS-JP 4.0 ガイドライン（2026-03-19）第3部 Flex 拡張 に合わせた列' };
})();

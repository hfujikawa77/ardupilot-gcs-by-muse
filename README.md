# ArduPilot GCS (by Muse)

Mission Planner / QGroundControl 風の Web グランドコントロールステーション。
ArduPilot SITL に MAVLink で接続し、ブラウザから機体の監視と操作ができます。

## 機能

- HUD（姿勢表示）・マップ上のライブ機体表示（機首方向に回転する三角形マーカー、飛行軌跡、カメラ追従）
- テレメトリ表示：フライトモード、アーム状態、バッテリー、GPS、EKF、RC チャンネル
- コマンド送信：モード変更（17モード）、アーム/ディスアーム、離陸、RTL、着陸、Guided GoTo（マップタップ指定）
- QGC 風バーチャルジョイスティック（ON 時は自動で LOITER に切替、入力途絶時のフェイルセーフ付き）
- QGC 式スライド確認（アーム・離陸・着陸・Goto 実行）
- 斜めビュー（ピッチ表示）での高度ポスト表示と 3D 軌跡表示

## 構成

- `client/` — React フロントエンド
- `server/` — サーバー層（アクション API）
- `server/bridge/mav_bridge.py` — pymavlink 製 MAVLink ブリッジ（SITL の TCP 5760 に接続し、HTTP で状態取得・コマンド受付）
- `drizzle/` — DB マイグレーション

## 開発

依存関係のインストールとビルドには Bun を使用します。

```sh
bun install
```

SITL 側は ArduPilot の `sim_vehicle.py` 等で起動し、TCP 5760 で待ち受けている前提です。
ブリッジはアプリ利用時に自動起動します。

---

このアプリは Muse（Meta のパーソナル AI エージェント）との対話で作成されました。

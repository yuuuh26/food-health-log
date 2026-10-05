# 食事・体調ログ v1.1.1

クラウド版: https://food-health-log-backups.dengana-10011212.workers.dev/
旧版: https://yuuuh26.github.io/food-health-log/

## 初回移行

1. 記録がある端末で旧版を開き、履歴・出力 → 全データをJSONで保存。
2. クラウド版を開き、履歴・出力 → 全データJSONを読み込む。
3. 件数確認後、クラウド保存・設定に専用の復旧キーと端末名を入力し接続。
4. 今すぐクラウド保存を押し、保存済み表示と履歴の件数を確認。
5. 新しい端末はキーで接続して、履歴から復元。旧版のデータは移行確認まで残す。

## 保存・認証

IndexedDBへ保存した変更を約2.5秒まとめて自動送信。認証とAPIは専用Workersオリジン内で実行。最新5世代を期限なしで保持。バックアップ1件10MiBまで、D1行は分割。

復旧キーは256bit乱数、サーバーにはハッシュだけを保存。端末セッションはSecure / HttpOnly / SameSite=Strictのホスト限定Cookie。端末管理は復旧キーで再認証。端末一覧から名前変更、個別/全端末取消、復旧キー変更が可能。キー変更時は新しいキーを必ず保管。

初回接続では空データを自動送信しない。記録・テンプレート・設定をバックアップし、送信中の編集は別の更新番号として残す。再送は同じ処理IDを使用。復元前は現データをJSONと端末内へ退避し、確認後に別の編集があれば置換を拒否する。リアルタイム同期ではなくバックアップと手動復元。

旧版とクラウド版のIndexedDBはオリジンが異なり、自動で引き継がれない。

## 開発・検証

Node.js 24以上で `npm test` / `npm run check`。テストは別のメモリ内DBと乱数キーを使い、本番の記録を変更しない。

`cloudflare/schema.sql` を専用D1へ適用。`cloudflare/site-worker.mjs` をWorkerの入口として、静的ファイルをまとめた `cloudflare/assets.mjs` と `cloudflare/worker.mjs` / `cloud-snapshot.js` を配備する。DB bindingは `DB`、認証用Secretは `BACKUP_TOKEN_SHA256`。元の復旧キーは公開リポジトリへ保存しない。再配備時はD1と既存Secretを保持する。

認証APIのレスポンスはno-store。Service Workerはアプリの静的ファイルだけを保存し、`/v1/` をキャッシュしない。

# Reset local E2EE device/key state for a clean test. LOCAL / TEST ONLY.
#
# WHY: toggling E2EE on/off + re-registering devices leaves STALE-but-trusted
# device rows on the server. The sender fans out to those stale devices (whose
# private keys no browser holds anymore) and skips the recipient's actual current
# device, so the recipient sees "[Encrypted - not available on this device]".
# Clearing the device/key tables makes every client re-register ONE clean,
# trusted, published device on next login, so encrypt/decrypt lines up.
#
# SAFE: touches ONLY the 4 E2EE crypto tables. Does NOT touch messages, users,
# conversations, files, or anything else. Devices re-register automatically.
# Already-encrypted test messages stay 🔒 (their keys are gone) — fine for a test.

$ErrorActionPreference = "Stop"
$sql = "SET FOREIGN_KEY_CHECKS=0; " +
       "DELETE FROM e2ee_history_sync; " +
       "DELETE FROM e2ee_one_time_prekeys; " +
       "DELETE FROM e2ee_conversation_keys; " +
       "DELETE FROM e2ee_devices; " +
       "SET FOREIGN_KEY_CHECKS=1; " +
       "SELECT 'devices_remaining' AS k, COUNT(*) AS n FROM e2ee_devices;"

Write-Host "Clearing server-side E2EE device/key state (collab-db)..." -ForegroundColor Cyan
docker exec collab-db mysql -ucolab -pcolab colab -e $sql

Write-Host ""
Write-Host "Server cleared. Now in EACH browser profile (BOTH test users), open" -ForegroundColor Green
Write-Host "DevTools (F12) -> Console and run:" -ForegroundColor Green
Write-Host ""
Write-Host "  Object.keys(localStorage).filter(k=>/e2ee|signal/i.test(k)).forEach(k=>localStorage.removeItem(k)); indexedDB.deleteDatabase('signal-store'); location.reload();" -ForegroundColor Yellow
Write-Host ""
Write-Host "Then log OUT and log IN once on each (so the device id binds into the" -ForegroundColor Green
Write-Host "token), and send a test DM. It should encrypt + decrypt cleanly." -ForegroundColor Green

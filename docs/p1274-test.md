# P12.7.4 — Hướng dẫn test trên Galaxy S9

Một lần build/flash, reboot giữa các pha đối chứng. Không dùng script P12.7.3
Test 2/3/4 cùng boot với P1274; recorder chỉ có một lượt/boot.

## Build

- Installer: trblsg/sios, workflow s9-installer, branch fix/s9-p124-thermal-installer.
- kernel_ref=s9/p12-4-guarded-thermal, packaging_ref=main, partition=SYSTEM,
  metal=true, fps=true, time_limit=0, tweaks=true, userdata_blocks=starlte=13917184.
- Boot args:

```text
hi=2 panel=1 p122=1 p12_gpu_boot_auto=1 mali_gov=1 mali_gov_frame=450 mali_probe=1 p3power=1 max77705_fg_s=10 p1273=1 p1274=1
```

Không thêm p1272_probe=1 (tránh job GPU nhân tạo), poster_probe=1, tmu_poll=200,
metal_layout=1, sleep_cores=1, syssleep=1, panel_sleep=1, p9_panel_mode=1,
mali_dvs=1, gov_policy=3 hoặc giới hạn tần số qua boot args. P1274 có timer quan sát
TMU riêng trong governor, không đổi tmu_poll stock. p1274=1 chỉ mở quyền yêu cầu,
không bật can thiệp lúc boot. Flash BOOT+SYSTEM cùng bản, giữ installer passphrase.
Dùng host kit `tools/p1274-host-9d948f2.zip` đóng gói từ kernel commit
`9d948f2fb2605749c272d933dbc23dea93407c10`. Kiểm tra commit trên log build trước khi flash.
Chưa có kết quả native build/hardware qualification; chỉ flash sau khi CI/build thành công.

## Chuẩn bị

Giải nén bộ host, mở PowerShell tại thư mục script, đóng PuTTY.
Thay COM125 bằng cổng thực tế. Giữ Wi-Fi/Bluetooth, cùng wallpaper, điều kiện nhiệt
và pin tương đương. Reboot mỗi pha. Nếu đã nóng, trở về recovery và làm nguội;
không cố chạy lại để đạt 84C. Với profile can thiệp cần có một lần touch thực
khi màn hình ON để kernel biết input đã yên; sau đó POWER một lần để OFF.
Bắt đầu script sớm (arm trước uptime 225s). Không chạm máy trong pha.
Script chờ OFF 25s và kiểm tra GPU domain/PLL off trước khi arm. TFR mở ở uptime
230s, trigger >=240s. Kết thúc tự động ở uptime 420s hoặc dừng bảo vệ sớm.
Ngưỡng bảo vệ không được nới.

## Lượt 1: Logging A/B/A

```powershell
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Profile BASE -RunDir .\logs\A0 -Execute
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Action Dump -RunDir .\logs\A0 -Execute
```

Dump mặc định tối đa 96 trang mới/lần. Chạy lại đúng lệnh Dump và cùng thư mục
để tiếp tục, không reboot. Nếu nóng, dừng và chỉ tiếp tục khi nguội cùng boot;
đừng hạ guard. Có thể dùng -MaxPages 32 hoặc 64 để giảm tải.
Sau khi có dump.complete, bật màn hình, thử thao tác UI, audio và radio bình
thường; nếu tốt và máy nguội:

```powershell
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Action WakeCheck -RunDir .\logs\A0 -ConfirmForeground -Execute
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Action Analyze -RunDir .\logs\A0 -Execute
```

Reboot, thay BASE/A0 bằng LOG2/B; sau đó reboot, BASE/A1. Dùng Capture, Dump,
WakeCheck, Analyze cho từng pha. Compare:

```powershell
.\s9-p1274-serial.ps1 -Action Compare -CompareDirs .\logs\A0,.\logs\B,.\logs\A1 -Execute
```

Nếu A0 dừng nhiệt, thu hồi dữ liệu khi nguội và gửi log; không ép chạy A1 nóng.
Mode LOG2 chỉ suppress logging layout/no-copy chưa triển khai; log khác còn
nguyên. Số API được lưu theo snapshot là cận dưới, không phải tổng cuối chính xác.

## Lượt 2: Hạ nhiệt chủ động

Sau khi xem Lượt 1, thử FAST và B1 độc lập, fresh boot mỗi pha.
B1 và FAST cùng chế độ logging LOG2; FAST có proactive thermal ceiling, không cap
cố định; đối chứng thích hợp là FAST/B1/FAST nếu workload tương đương.

```powershell
.\s9-p1274-serial.ps1 -Profile FAST -RunDir .\logs\FastA0 -AllowIntervention -Execute
.\s9-p1274-serial.ps1 -Profile B1 -RunDir .\logs\CapB1 -AllowIntervention -Execute
```

Sau Capture/Dump/WakeCheck/Analyze B1 có summary.json qualified=true và được
review, B2 mới được thử; tương tự B3 sau B2.

```powershell
.\s9-p1274-serial.ps1 -Profile B2 -RunDir .\logs\CapB2 -AllowIntervention -PriorReport .\logs\CapB1\summary.json -Execute
.\s9-p1274-serial.ps1 -Profile B3 -RunDir .\logs\CapB3 -AllowIntervention -PriorReport .\logs\CapB2\summary.json -Execute
```

Không chạy liền các lệnh trên: mỗi pha cần reboot, hoàn thành và review dữ liệu.
Qualification chỉ là cổng host dựa trên mẫu, không chứng nhận hardware; nếu
không qualified, gửi logs để phân tích, không bypass.

## Lượt 3: Pin thật

Dùng cùng profile, reboot, thêm -Power Offline -AllowOffline. Script báo rút
cáp và đếm thời gian cần giữ unplugged đến sau uptime 420s. Không cần tương tác
trên máy trong thời gian này. Chỉ cắm lại khi host báo. Nếu COM đổi, dùng
-ReconnectPort COMxxx ở Capture; dùng -Port mới ở Dump.
Nếu mất kết nối hoặc nhiệt cao, kernel vẫn có deadline; giữ nguyên boot nếu
an toàn và dump sau khi nguội.

```powershell
.\s9-p1274-serial.ps1 -Profile LOG2 -Power Offline -AllowOffline -RunDir .\logs\BatteryA -Execute
```

Đối chiếu LOG2 Connected/Offline/Connected trên các boot khác nhau.
Dùng cùng loại nguồn/điều kiện khi so cap energy. Kiểm tra external=0, USB down
và dữ liệu FG phủ 250–410s, không có khoảng trống >15s. QH raw delta có wrap,
chưa biết hệ số; Wh là tích phân công suất pin có dấu, không phải SoC rail.
Mất VBUS đồng thời mất USB traffic, không chứng minh riêng cơ chế DAS.

## Recommended cores (chỉ sau Lượt 2)

R2 → R1 → R0, riêng từng boot, -AllowIntervention -PriorReport summary.json
của B1/B2/B3 đã qualified cho R2, R2 cho R1, R1 cho R0. Không ép OCP off.
Chưa đo được latency wake tự động; WakeCheck là xác nhận thao tác của operator.
Khác biệt requested/actual mask hoặc không khôi phục đủ 8 nhân => dừng.

## File cần giữ

Toàn bộ thư mục log của từng pha: capture.json, status/trace-status.txt,
pages.txt, trace-pages.txt, trace-cpu*.txt, GPU files, *.journal.txt, *.log,
*.samples.csv, restore.json, wake.json, dump.complete, summary.json, CSV
được trích xuất. Nếu dừng sớm, vẫn giữ mọi file. Chưa hoàn tất Dump vẫn có thể
Analyze dữ liệu từng phần nhưng không được qualified. Không sửa thủ công
summary để vượt gate. Không chuyển log thành commit.

## Giới hạn cần kiểm chứng

Mọi can thiệp mặc định off; Fast TMU target ~200ms không bảo đảm ADC cập nhật
hay DVFS thực tế dưới 300ms; chỉ ghi timestamp để đánh giá. TFR giữ một event,
có thể trigger sớm trong 240–420s hoặc không gặp burst. User counter snapshot
có thể thiếu đuôi, process mới từ cputop 5s không phải launchd hook, không
chứng minh CPU fallback. Userland sandbox có thể từ chối telemetry. WFI bỏ
interval đang chạy tại freeze, không tương đương rail residency. Cần native CI,
full firmware build và test thực tế trước khi xác nhận hiệu quả.

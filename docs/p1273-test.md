# P12.7.3 – Hướng dẫn Test Galaxy S9 Exynos (Windows)

**Firmware bắt buộc:** kernel `ee597e843386a45293f90b9800889593983bf812` (P12.7.3), installer `88bae13` hoặc bản có cùng kernel/boot ABI. Boot args có `p1273=1 p1272_probe=1`. Đây là bộ test LAB, chưa có kết quả native/hardware; không tự kích hoạt Combined, CPU cap hoặc Metal layout lúc boot.

## Chuẩn bị
- Giải nén toàn bộ `p1273-host-ee597e8.zip` vào một thư mục trên Windows; không trộn script từ phiên cũ.
- Mở Windows PowerShell 5.1 trong thư mục giải nén. Đóng PuTTY và các chương trình đang giữ COM. Kiểm tra cổng bằng `[IO.Ports.SerialPort]::GetPortNames()`. Các lệnh dưới đây dùng COM125 theo phiên trước; sửa nếu cổng khác. Nếu COM thay đổi sau rút USB, truyền thêm `-ReconnectPort COM126` với số cổng thực tế.
- Để máy nguội, giữ USB ổn định. Không cố tạo nhiệt để kích hoạt trigger. Nếu máy bất thường, hình lỗi, reboot/panic hoặc host báo STOP, giữ log và dừng thử nghiệm. Các lease có timeout độc lập, nhưng timeout không chứng minh phần cứng đã phục hồi. Không reboot trước khi đọc xong ring frozen nếu máy còn an toàn.
- Không cần symbol map cho các Test dưới đây; nếu dùng `-SymbolMap <đường dẫn>` phải đúng kernel build, không dùng map cũ.
- Launcher kiểm tra SHA256 của bộ script khi `-Execute`, chạy từng test độc lập, lưu thư mục log riêng. Bỏ `-Execute` để chỉ xem command, không kết nối thiết bị. Không chạy tất cả Test tự động.

## Lượt đầu – thu thập dữ liệu, không bật chính sách mới
Chạy lần lượt; nếu Test 1 không PASS, gửi log để phân tích trước khi chạy can thiệp. Test 2 chỉ arm recorder; phải chạy Test 3 và 4 khi còn cùng boot để lấy dữ liệu.

### Test 1 – GPU cache, xác nhận lỗi MMIO đã được chặn
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 1 -Port COM125 -Execute
```
Chạy sớm sau khi iOS boot; worker opt-in chỉ chờ request tối đa 900 giây, một lần mỗi boot. Nếu màn hình đang ON, chờ prompt rồi bấm POWER đúng một lần để OFF. Giữ màn hình OFF, không chạm, không rút USB. Script yêu cầu GPU OFF và đủ nguội; đọc 41 thông số không đánh thức GPU, một job thật, so sánh ON và xác nhận re-gate. Tìm `P1272 GPU_CACHE_CHECK PASS`. Nếu không đủ điều kiện, không cố tăng nhiệt hay gửi lại request liên tục.

### Test 2 – Thermal Flight Recorder
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 2 -Port COM125 -Execute
```
OFF và giữ nguyên máy, USB kết nối. Tối đa 180 giây arm sau bước ổn định OFF. Recorder giữ 32 giây lịch sử, trigger tải cluster >=60% hoặc GPU wake thành công, <=10 giây post-trigger. Không cần thao tác chủ động để gây burst. Tìm `P1273 TRACE FROZEN`, kiểm tra trigger khác 0. Nếu trigger=0 vẫn dump để đánh giá coverage, nhưng không kết luận nguyên nhân hoặc thử cap. Mỗi boot chỉ một capture. Mở màn hình sẽ freeze.

### Test 3 – lấy GPU job + governor ring
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 3 -Port COM125 -Execute
```
Không reboot sau Test 2; có thể chạy readout khi màn hình ON hoặc OFF, giữ trạng thái máy ổn định. Tìm `GPU/GOV DUMP COMPLETE`. Ưu tiên GPU ring trước CPU dump dài. Các job pending/overwritten không được coi như 0.

### Test 4 – lấy CPU PID/TID recorder
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 4 -Port COM125 -Execute
```
Đọc từng page của 8 CPU; có thể kéo dài tùy số owner/page. Không dừng do thấy chưa có output liên tục. Không reboot, không ngắt USB. Tìm `TRACE DUMP COMPLETE`. Nếu transport lỗi, giữ phần đã lưu; có thể chạy lại readout khi ring vẫn frozen cùng boot. Không tự arm lại recorder.

### Test 5 – Floor reason, ACPM cache, WFI v2
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 5 -Port COM125 -Execute
```
Chỉ đọc dữ liệu chẩn đoán; cache ACPM chưa lấy mẫu hoặc stale là bình thường trước Test 6. WFI là bộ đếm tích lũy, không phải số đo chênh lệch một pha.

### Test 6 – ACPM bus trace
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 6 -Port COM125 -Execute
```
Sau khi Test 1–5 đã được xem xét. OFF, USB giữ kết nối. 90 giây policy baseline P127 mode 1 (P126 COMBINED), không bật module thử nghiệm mới; thu bus domain round-robin và WFI/FG trước sau. Không phải hoàn toàn read-only: có lease baseline. Không kết luận rate=0 là domain OFF nếu mẫu không valid.

**Gửi toàn bộ thư mục logs của Test 1–6 (kể cả STOP/incomplete).** Không chỉ gửi putty.log. Sau khi kiểm tra dữ liệu mới quyết định các Test dưới.

## Lượt sau – can thiệp có điều kiện
Các Test 7–12 không chạy ngay sau build nếu chưa xem log lượt đầu. Mỗi test cần chính sách cũ đã restore, nhiệt hợp lệ, điều kiện GPU OFF và input guard. Không cố bypass nếu bị từ chối.

### Test 7 – PSR A/B/A 30 giây mỗi pha
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 7 -Port COM125 -Execute
```
Giữ OFF, USB kết nối. So sánh legacy 300ms / governor PSR / legacy, xem owner/drain/ticks/masks/unmasks/faults. Sau khi hoàn tất, kiểm tra wake, hình ảnh, scroll bình thường; không coi timer giảm là panel rail OFF.

### Test 8 – FunctionalGate từng module
Ví dụ USB (cổng COM thay đổi thì thêm -ReconnectPort):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 8 -Module USB -AllowFunctionalGate -Port COM125 -Execute
```
Thay `USB` bằng ABOX, BT, WIFI, TICKER, LITTLE949 cho từng lần riêng. Không chạy song song. USB có prompt rút/cắm thật; giữ OFF. BT/WIFI/TICKER cần traffic nền thật từ thiết bị khác khi S9 OFF; không tự bật màn hình trong pha active. ABOX cần idle trong pha active, sau restore mở màn hình, phát âm thanh thật và ghi âm/phát lại. LITTLE949 chỉ bấm POWER khi script yêu cầu để kiểm tra revoke floor. Khi script báo policy OFF, kiểm tra chức năng thực tế (âm thanh/mic, kết nối BT/WiFi, network/timer, input/UI tùy module); bấm Y trên **máy tính** chỉ khi đã kiểm tra thành công, N nếu lỗi. Không bấm Y thay cho bằng chứng kernel. Thiếu dữ liệu -> không qualify. Gate RAM cùng boot, tối đa 1 giờ, lỗi/expiry có thể hủy. Nếu không tạo được workload hợp lệ thì giữ INCONCLUSIVE.

### Test 9 – OFF burst cap
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 9 -Port COM125 -AllowOffCap -Execute
```
Chỉ sau khi phân tích Test 2–4 có frozen trigger thật; cùng boot. A/B/A observe/mild/observe, B BIG 1469 MHz/LITTLE 1248 MHz, tối đa 15 giây active mỗi pha. Chờ trigger tự nhiên <=60 giây. Không có trigger -> inconclusive. Không thêm -AllowStrongerCap trừ khi mild đủ measured readback và đã review; mức mạnh BIG 1261/LITTLE 1053 MHz không phải mặc định.

### Test 10 – offline A/B/A
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 10 -Module ABOX -AllowOfflineTrial -Port COM125 -Execute
```
Chỉ module đã kiểm chứng chức năng. A0/B/A1 đều **rút USB thật** theo prompt từng pha; đợi host yêu cầu cắm lại (host chờ 65 giây cho lease 60 giây), không cắm sớm. Giữ OFF. Module ABOX, BT, WIFI, TICKER, LITTLE949. Không thử COMBINED nếu chưa đủ gate riêng. Có thể cần -ReconnectPort. Kiểm tra reason=10, cùng boot nonce, dữ liệu discharge, common support >=30 giây. Kết quả là net battery W trên khoảng quan sát, không phải rail power hay chứng minh nhân quả.

### Test 11 – Combined connected A/B/A
Chỉ khi toàn bộ gate riêng đã qualified cùng boot. COMBINED5 (903) cần USB/ABOX/BT/WIFI/TICKER (qualified bitmask 31); sau đó phải gate chính COMBINED5:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 8 -Module COMBINED5 -AllowFunctionalGate -AllowCombined -Port COM125 -Execute
```
Chỉ khi đạt bitmask 95 (các bit yêu cầu, có thể còn bit khác) mới chạy:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 11 -Module COMBINED5 -AllowCombined -Port COM125 -Execute
```
COMBINED6 (919) cần thêm LITTLE949 và qualified COMBINED5 (127), rồi gate riêng COMBINED6, đủ 255. Không chạy hai profile liên tiếp tự động. Kiểm tra per-module APPLIED/NO_EVIDENCE. Sau khi review có thể dùng Test 10 với COMBINED5/6 và cả -AllowCombined, -AllowOfflineTrial; không mặc định thực hiện.

### Test 12 – A/B/A từng module, USB kết nối
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\s9-p1273-test.ps1 -Test 12 -Module ABOX -Port COM125 -Execute
```
Chỉ một module đã review mỗi lần (USB, ABOX, BT, WIFI, TICKER, LITTLE949). 30 giây mỗi pha. PSR dùng Test 7. Không tự động hạ thêm floor. APPLIED là đường code được sử dụng, không đồng nghĩa functional gate hay giảm năng lượng. Điện pin khi USB kết nối không phải công suất thiết bị.

## Metal – test riêng trên shell iOS
Sau khi xác nhận boot ổn và có shell thực trên S9 (không nhập các lệnh này vào USB console sctl):
```sh
/redwood/bin/metal_test p1273-metal-log-aba
/redwood/bin/metal_test p1273-layout-check
```
Chạy riêng từng lệnh, thu stdout/log. Log A/B/A 0/1/0 fresh process, layout disabled; layout check opt-in process riêng với RGBA8 CPU/GPU readback, render và deallocator. Không bật metal_layout=1 ở boot hay chạy trên PosterBoard. Nếu không có shell, bỏ qua và báo lại; host serial không có đường exec tùy ý. Không chạy đồng thời ThermalTrace, cap, energy/gate tests.

## Log cần gửi
Mỗi thư mục TestNN-* chứa test-info.txt (command, source commit, exit code), raw *.log, *.events.txt, *.samples.csv, *.p125-report.txt, *.p125-snapshots.txt, *.readback-journal.txt và checkpoint/CSV tùy Test. Ưu tiên giữ mọi file *.thermal-*.*, *.p1273-diag.txt, *.gate.clixml, *.cap.clixml, *.floor-denial.txt, *.psr.txt, *.fg*.csv, *.wfi.csv, *.offline-energy.csv. Gửi cả log lỗi và partial page; không xóa log khi thiếu PASS. Nếu upload nặng, nén riêng toàn bộ thư mục Test. Host exit 0 không thay thế bằng chứng PASS trong report. Không gửi mật khẩu/credential.

## An toàn và giới hạn
Giữ CPU_OFF, CPU_SUSPEND, DCS panel sleep, điện áp và boot-time Metal layout tắt; không thêm floor/cap boot args. Bộ script không tự flash, không chạy installer, không bypass thermal guard. Không đảm bảo test hardware sẽ pass: build native và qualification thiết bị vẫn cần kết quả thực. Có thể thực hiện các test cùng firmware đã flash, không cần build lại cho bộ host-only này.

-- ============================================================
-- Sample Data Seed
-- ============================================================

-- Users
INSERT INTO users (name, code, role, avatar_color) VALUES
  ('Nguyễn Văn An', 'AN', 'sales', '#00d4aa'),
  ('Trần Thị Bình', 'BI', 'sales', '#7c3aed'),
  ('Lê Minh Cường', 'CU', 'sales', '#f59e0b'),
  ('Phạm Thị Dung', 'DU', 'sales', '#ec4899'),
  ('Hoàng Văn Em', 'EM', 'sales', '#3b82f6'),
  ('Vũ Thị Fương', 'FU', 'sales', '#10b981'),
  ('Trưởng Phòng', 'TP', 'lead', '#ff6b35')
ON CONFLICT (code) DO NOTHING;

-- =====================
-- Report 1: AN - Today
-- =====================
WITH r AS (
  INSERT INTO reports (user_id, report_date, total_contacts, new_customers, issues)
  VALUES (
    (SELECT id FROM users WHERE code='AN'),
    CURRENT_DATE,
    5, 2,
    'Khách Thanh Hương cần phê duyệt giá từ trưởng phòng trước khi chốt, dự kiến volume lớn 200 CBM/tháng.'
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET updated_at = NOW()
  RETURNING id
),
-- Customer 1: Quoted
c1 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='AN'),
    'Công ty TNHH Dệt May Thanh Hương',
    'Chị Hương - Trưởng XNK',
    '0901 234 567',
    'referral',
    'Dệt may / Textile',
    'quoted',
    'Vận chuyển hàng dệt may FCL từ HCM sang Đức, volume 2-3 cont 40HC/tháng',
    'Khách đã nhận báo giá, đang so sánh với Nippon Express. Có quan hệ với Bee Logistics nên cần giá cạnh tranh.',
    'Gọi lại xác nhận sau khi có phê duyệt giá từ TP',
    CURRENT_DATE + 2
  )
  RETURNING id
),
-- Customer 2: Contacted
c2 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='AN'),
    'Vinaplast Co., Ltd',
    'Anh Minh - Giám đốc',
    '0912 345 678',
    'cold_call',
    'Nhựa / Plastics',
    'contacted',
    'Nhập khẩu hạt nhựa từ Saudi Arabia, dự kiến 2 cont 20'' mỗi tháng',
    'Anh Minh bận, hẹn gặp tuần sau. Hiện đang dùng dịch vụ của Transimex.',
    'Gửi email giới thiệu năng lực + đặt lịch gặp',
    CURRENT_DATE + 5
  )
  RETURNING id
),
-- Customer 3: Saved
c3 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='AN'),
    'Công ty CP Đồ Gỗ Hòa Phát',
    'Ms. Linh - XNK',
    '0933 456 789',
    'zalo_facebook',
    'Đồ gỗ / Furniture',
    'saved',
    'Tìm được contact qua LinkedIn. Công ty xuất gỗ sang Mỹ thường xuyên.',
    'Liên hệ lần đầu để giới thiệu',
    CURRENT_DATE + 3
  )
  RETURNING id
)
-- Quotes for Customer 1
INSERT INTO quotes (customer_id, cargo_name, monthly_volume_cbm, monthly_volume_containers, route, cargo_ready_date, mode, carrier, transit_time, price, status, follow_up_notes, closing_soon)
VALUES
  (
    (SELECT id FROM c1),
    'Hàng dệt may - Áo thun, quần tây',
    NULL, '2-3 x 40HC',
    'HCM → Hamburg, Germany',
    CURRENT_DATE + 14,
    'sea',
    'MSC / CMA-CGM',
    '28-32 ngày',
    'USD 2,200/40HC (all-in)',
    'follow_up',
    'Khách đang chờ phê duyệt nội bộ. Competitor quote USD 2,350.',
    TRUE
  ),
  (
    (SELECT id FROM c1),
    'Hàng dệt may - mẫu nhỏ air',
    45, NULL,
    'SGN → FRA (Frankfurt)',
    CURRENT_DATE + 7,
    'air',
    'Vietnam Airlines Cargo',
    '2-3 ngày',
    'USD 4.5/kg (min 100kg)',
    'quoting',
    NULL,
    FALSE
  );

-- ========================
-- Report 2: BI - Yesterday
-- ========================
WITH r AS (
  INSERT INTO reports (user_id, report_date, total_contacts, new_customers, issues)
  VALUES (
    (SELECT id FROM users WHERE code='BI'),
    CURRENT_DATE - 1,
    4, 1,
    'Cần hỗ trợ báo giá hàng nguy hiểm (DG cargo) cho Sunrise Electronics.'
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET updated_at = NOW()
  RETURNING id
),
c1 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='BI'),
    'Sunrise Electronics Corp',
    'Mr. Kenji Tanaka - Logistics',
    '028 3829 1234',
    'email',
    'Điện tử / Electronics',
    'quoted',
    'Air freight linh kiện điện tử từ HCM sang Tokyo và Osaka, weekly shipment ~500kg',
    'Khách Nhật, yêu cầu cao về document. Cần CO, Form D. Có lô hàng DG (pin lithium).',
    'Gửi báo giá DG cargo + làm rõ về document requirement',
    CURRENT_DATE + 1
  )
  RETURNING id
),
c2 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='BI'),
    'Mekong Food Export JSC',
    'Chị Lan - GĐ Xuất Khẩu',
    '0908 765 432',
    'referral',
    'Thực phẩm / Food & Beverage',
    'quoted',
    'Xuất gạo thơm và cà phê sang Mỹ - LA, 3-4 cont 20'' mỗi tháng, hàng kiểm thực phẩm',
    'Được giới thiệu từ khách cũ Vinamit. Chị Lan rất chuyên nghiệp, cần giá tốt và service chắc.',
    'Gửi booking xác nhận space tháng tới',
    CURRENT_DATE + 3
  )
  RETURNING id
),
c3 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='BI'),
    'Hòa Bình Steel Trading',
    'Anh Phong - Trưởng Mua Hàng',
    '0977 111 222',
    'cold_call',
    'Thép / Steel',
    'contacted',
    'Nhập khẩu thép cuộn từ Trung Quốc và Hàn Quốc',
    'Anh Phong tiếp nhận thông tin, công ty đang tìm forwarder mới do thủ tục hải quan hiện tại chậm.',
    'Chuẩn bị hồ sơ năng lực + case study thép nhập khẩu',
    CURRENT_DATE + 4
  )
  RETURNING id
)
INSERT INTO quotes (customer_id, cargo_name, monthly_volume_kg, route, cargo_ready_date, mode, carrier, transit_time, price, status, closing_soon)
VALUES
  (
    (SELECT id FROM c1),
    'Linh kiện điện tử - PCB, sensors',
    2000,
    'SGN → NRT (Tokyo Narita)',
    CURRENT_DATE - 1 + 7,
    'air',
    'ANA Cargo / JAL Cargo',
    '1-2 ngày',
    'USD 5.8/kg (all-in, min 45kg)',
    'follow_up',
    TRUE
  ),
  (
    (SELECT id FROM c2),
    'Gạo thơm ST25 + cà phê Robusta',
    NULL,
    'HCM → Los Angeles, USA',
    CURRENT_DATE - 1 + 21,
    'sea',
    'Evergreen / ONE',
    '25-28 ngày',
    'USD 1,800/20'' (all-in)',
    'booked',
    FALSE
  );

-- ==========================
-- Report 3: CU - 2 days ago
-- ==========================
WITH r AS (
  INSERT INTO reports (user_id, report_date, total_contacts, new_customers, issues)
  VALUES (
    (SELECT id FROM users WHERE code='CU'),
    CURRENT_DATE - 2,
    6, 3,
    NULL
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET updated_at = NOW()
  RETURNING id
),
c1 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='CU'),
    'Hoàng Long Machinery Import',
    'Mr. David Chen - Purchasing',
    '024 3938 5555',
    'referral',
    'Máy móc / Machinery',
    'quoted',
    'Nhập máy móc từ Đức và Ý về Hải Phòng, hàng nặng OOG (out of gauge)',
    'Công ty Hà Nội, nhập máy CNC và dây chuyền sản xuất. Project cargo, cần heavy-lift.',
    'Liên hệ partner tại HP để confirm survey + chi phí THC',
    CURRENT_DATE - 2 + 10
  )
  RETURNING id
),
c2 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='CU'),
    'Fuji Vietnam Manufacturing Co., Ltd',
    'Ms. Yuki Sato - SCM',
    '0236 3885 999',
    'direct',
    'Sản xuất / Manufacturing',
    'quoted',
    'Xuất linh kiện auto sang Nhật và Hàn, volume lớn 10-15 cont/tháng',
    'Gặp trực tiếp tại triển lãm VIETSHIP. Công ty 100% vốn Nhật, rất tiềm năng. Cần quote nhanh.',
    'Submit revised quote sau khi có fuel surcharge mới',
    CURRENT_DATE - 2 + 5
  )
  RETURNING id
),
c3 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='CU'),
    'Đông Nam Á Ceramics Export',
    'Anh Tuấn - XNK Manager',
    '0511 3737 888',
    'cold_call',
    'Gốm sứ / Ceramics',
    'contacted',
    'Xuất gốm sứ Bát Tràng sang Mỹ và EU, hàng fragile cần special packaging',
    'Anh Tuấn quan tâm nhưng cần approval từ BGĐ. Gửi profile công ty trước.',
    'Gửi profile + tham khảo case tương tự đã làm',
    CURRENT_DATE - 2 + 7
  )
  RETURNING id
)
INSERT INTO quotes (customer_id, cargo_name, monthly_volume_cbm, monthly_volume_kg, monthly_volume_containers, route, cargo_ready_date, mode, carrier, transit_time, price, status, follow_up_notes, lost_reason, closing_soon)
VALUES
  (
    (SELECT id FROM c1),
    'Máy CNC + phụ tùng - OOG',
    320, NULL, '1 x 40OT + 2 x 40HC',
    'Hamburg, Germany → Hải Phòng',
    CURRENT_DATE - 2 + 30,
    'sea',
    'Hapag-Lloyd',
    '35-38 ngày',
    'USD 4,500 (all-in incl. OOG surcharge)',
    'quoting',
    'Chờ confirm kích thước máy chính xác từ supplier Đức',
    NULL,
    FALSE
  ),
  (
    (SELECT id FROM c2),
    'Linh kiện auto - bracket, harness',
    NULL, NULL, '10-15 x 40HC',
    'Đà Nẵng → Busan, Korea / Osaka, Japan',
    CURRENT_DATE - 2 + 14,
    'sea',
    'HMM / Sinokor',
    '5-7 ngày',
    'USD 950/40HC to Korea, USD 1,100/40HC to Japan',
    'follow_up',
    'Khách đang so sánh với Kuehne+Nagel. Chúng ta competitive hơn về transit time.',
    NULL,
    TRUE
  ),
  (
    (SELECT id FROM c2),
    'Linh kiện auto - air urgent',
    NULL, 500, NULL,
    'DAD → ICN (Seoul Incheon)',
    CURRENT_DATE - 2 + 3,
    'air',
    'Korean Air Cargo',
    '1 ngày',
    'USD 7.2/kg (all-in)',
    'booked',
    'Đã confirm booking cho lô khẩn cấp tháng này',
    NULL,
    FALSE
  );

-- ==========================
-- Report 4: AN - 3 days ago
-- ==========================
WITH r AS (
  INSERT INTO reports (user_id, report_date, total_contacts, new_customers, issues)
  VALUES (
    (SELECT id FROM users WHERE code='AN'),
    CURRENT_DATE - 3,
    3, 1,
    NULL
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET updated_at = NOW()
  RETURNING id
),
c1 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='AN'),
    'Vinamilk Export Division',
    'Chị Thảo - Logistics Manager',
    '028 5413 5555',
    'email',
    'Sữa & Thực phẩm / Dairy & Food',
    'quoted',
    'Air freight sữa bột xuất sang Singapore và Malaysia, 2-3 tấn/lần, 2 lần/tháng',
    'Lead từ email marketing. Chị Thảo rất professional, đã gửi RFQ chi tiết.',
    'Follow up xác nhận rate validity và booking schedule',
    CURRENT_DATE - 3 + 14
  )
  RETURNING id
),
c2 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='AN'),
    'TechParts Vietnam Ltd',
    'Mr. Robert Kim - Operations',
    '0909 888 777',
    'zalo_facebook',
    'Điện tử / Electronics',
    'saved',
    'Tìm được qua group Facebook Logistics Vietnam. Chưa gọi được.',
    'Gọi điện lần đầu',
    CURRENT_DATE - 3 + 2
  )
  RETURNING id
)
INSERT INTO quotes (customer_id, cargo_name, monthly_volume_kg, route, cargo_ready_date, mode, carrier, transit_time, price, status, closing_soon)
VALUES
  (
    (SELECT id FROM c1),
    'Sữa bột xuất khẩu - Vinamilk brand',
    6000,
    'SGN → SIN (Singapore Changi)',
    CURRENT_DATE - 3 + 10,
    'air',
    'Singapore Airlines Cargo',
    '1 ngày',
    'USD 2.8/kg (all-in)',
    'follow_up',
    TRUE
  );

-- Report 5: FU - Today (additional data)
WITH r AS (
  INSERT INTO reports (user_id, report_date, total_contacts, new_customers, issues)
  VALUES (
    (SELECT id FROM users WHERE code='FU'),
    CURRENT_DATE,
    3, 2,
    NULL
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET updated_at = NOW()
  RETURNING id
),
c1 AS (
  INSERT INTO customers (report_id, user_id, company_name, contact_person, phone, source, industry, interaction_type, needs, notes, next_action, follow_up_date)
  VALUES (
    (SELECT id FROM r),
    (SELECT id FROM users WHERE code='FU'),
    'Green Energy Vietnam JSC',
    'Anh Phúc - Giám Đốc',
    '0358 123 456',
    'direct',
    'Năng lượng / Energy',
    'quoted',
    'Nhập tấm pin mặt trời từ Trung Quốc - Thượng Hải, 500KW/tháng (~20 cont)',
    'Gặp tại hội nghị năng lượng tái tạo Hà Nội. Công ty đang mở rộng, nhu cầu tăng mạnh.',
    'Gửi spot rate + confirm shipping schedule',
    CURRENT_DATE + 3
  )
  RETURNING id
)
INSERT INTO quotes (customer_id, cargo_name, monthly_volume_containers, route, cargo_ready_date, mode, carrier, transit_time, price, status, closing_soon)
VALUES
  (
    (SELECT id FROM c1),
    'Solar panels - 500W monocrystalline',
    '20 x 40HC',
    'Shanghai, China → HCM',
    CURRENT_DATE + 20,
    'sea',
    'COSCO / PIL',
    '10-12 ngày',
    'USD 1,100/40HC (all-in)',
    'quoting',
    FALSE
  );

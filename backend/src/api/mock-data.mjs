// GM-001専用の架空データ。Slack週次処理のモックとは共有しない。
export function createMockPeople() {
  return [
    { person_id: '00000000-0000-4000-8000-000000000001', display_name: '架空アオ', terms_accepted: true, feedback_opt_in: false },
    { person_id: '00000000-0000-4000-8000-000000000002', display_name: '架空ミドリ', terms_accepted: false, feedback_opt_in: false },
    { person_id: '00000000-0000-4000-8000-000000000003', display_name: '架空ソラ', terms_accepted: true, feedback_opt_in: true },
  ];
}

export const places = [
  { id: 'kitchen', name: '共用キッチン' },
  { id: 'laundry', name: '洗濯室' },
];

export const analysis = {
  sentiment: 'motto', target_type: 'place', target_id: 'kitchen', target_label: '共用キッチン',
};

export const counts = {
  kitchen: { place_id: 'kitchen', period_days: 7, good_count: 8, motto_count: 12, updated_at: '2026-11-04T04:00:00Z' },
  laundry: { place_id: 'laundry', period_days: 7, good_count: 1, motto_count: 2, updated_at: '2026-11-04T04:00:00Z' },
};

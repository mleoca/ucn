test('uses a local index', () => {
    const index = new Map<string, number>();
    index.set('answer', 42);
    expect(index.get('answer')).toBe(42);
});

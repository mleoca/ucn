package fixtures;

import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Utility functions for data manipulation.
 */
public class Utils {

    /**
     * Format data as a map.
     */
    public static Map<String, Object> formatData(Object data) {
        if (data == null) {
            return new HashMap<>();
        }
        if (data instanceof Map) {
            return new HashMap<>((Map<String, Object>) data);
        }
        Map<String, Object> result = new HashMap<>();
        result.put("value", data);
        return result;
    }

    /**
     * Validate that a value is not null.
     */
    public static <T> T validateNotNull(T value, String message) {
        if (value == null) {
            throw new IllegalArgumentException(message);
        }
        return value;
    }

    /**
     * Deep merge two maps.
     */
    public static Map<String, Object> deepMerge(
            Map<String, Object> base,
            Map<String, Object> updates) {
        Map<String, Object> result = new HashMap<>(base);
        for (Map.Entry<String, Object> entry : updates.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();
            if (result.containsKey(key) &&
                result.get(key) instanceof Map &&
                value instanceof Map) {
                result.put(key, deepMerge(
                    (Map<String, Object>) result.get(key),
                    (Map<String, Object>) value
                ));
            } else {
                result.put(key, value);
            }
        }
        return result;
    }

    /**
     * Flatten a nested list.
     */
    public static <T> List<T> flatten(List<List<T>> nested) {
        return nested.stream()
                .flatMap(List::stream)
                .collect(Collectors.toList());
    }

    /**
     * Split a list into chunks.
     */
    public static <T> List<List<T>> chunk(List<T> items, int size) {
        List<List<T>> chunks = new ArrayList<>();
        for (int i = 0; i < items.size(); i += size) {
            chunks.add(items.subList(i, Math.min(i + size, items.size())));
        }
        return chunks;
    }

    /**
     * Safely get a nested value from a map.
     */
    public static Object safeGet(Map<String, Object> map, String path) {
        String[] keys = path.split("\\.");
        Object current = map;
        for (String key : keys) {
            if (current instanceof Map) {
                current = ((Map<String, Object>) current).get(key);
            } else {
                return null;
            }
        }
        return current;
    }

    /**
     * Transform all keys in a map.
     */
    public static Map<String, Object> transformKeys(
            Map<String, Object> map,
            Function<String, String> transformer) {
        Map<String, Object> result = new HashMap<>();
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            result.put(transformer.apply(entry.getKey()), entry.getValue());
        }
        return result;
    }

    /**
     * Convert snake_case to camelCase.
     */
    public static String snakeToCamel(String name) {
        StringBuilder result = new StringBuilder();
        boolean capitalizeNext = false;
        for (char c : name.toCharArray()) {
            if (c == '_') {
                capitalizeNext = true;
            } else if (capitalizeNext) {
                result.append(Character.toUpperCase(c));
                capitalizeNext = false;
            } else {
                result.append(c);
            }
        }
        return result.toString();
    }

    /**
     * Convert camelCase to snake_case.
     */
    public static String camelToSnake(String name) {
        StringBuilder result = new StringBuilder();
        for (char c : name.toCharArray()) {
            if (Character.isUpperCase(c)) {
                if (result.length() > 0) {
                    result.append('_');
                }
                result.append(Character.toLowerCase(c));
            } else {
                result.append(c);
            }
        }
        return result.toString();
    }

    /**
     * Data transformer class.
     */
    public static class DataTransformer {
        private final List<Function<Object, Object>> transformations;

        public DataTransformer() {
            this.transformations = new ArrayList<>();
        }

        /**
         * Add a transformation.
         */
        public DataTransformer addTransformation(Function<Object, Object> fn) {
            transformations.add(fn);
            return this;
        }

        /**
         * Apply all transformations.
         */
        public Object transform(Object data) {
            Object result = data;
            for (Function<Object, Object> fn : transformations) {
                result = fn.apply(result);
            }
            return result;
        }

        /**
         * Clear all transformations.
         */
        public void clear() {
            transformations.clear();
        }
    }

    /**
     * Process and format data.
     */
    public static Map<String, Object> processAndFormat(Object data) {
        Object validated = validateNotNull(data, "Data cannot be null");
        return formatData(validated);
    }

    /**
     * Unused method for deadcode detection.
     */
    @SuppressWarnings("unused")
    private static void unusedHelper() {
        // This method is never called
    }
}
